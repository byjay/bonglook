---------------------------- MODULE config_keys ----------------------------
(***************************************************************************)
(* API key merge across the renderer boundary. Models src/config-keys.js   *)
(* (sanitizeConfig, mergeIncomingKeys) and renderer snapshots that may be  *)
(* stale. Each Save is one atomic config:set handler: the main process is  *)
(* single threaded and the handler has no await before store.set.          *)
(*                                                                         *)
(* Abstractions:                                                           *)
(*  - per-provider stored keys are one set; the mirror fields aiChain,     *)
(*    apiKeysByProvider, apiKeys and key order are collapsed into it       *)
(*    (those are covered by scripts/test-config-keys.cjs, not by this).    *)
(*  - fingerprint and keysRev are injective (truncated SHA-256 collisions  *)
(*    are assumed away). keysRev is modelled as the key content itself.    *)
(*                                                                         *)
(* Fix toggles, each FALSE reproduces a real defect:                       *)
(*   SanitizeOn  FALSE: config:get returns raw keys (the original leak)    *)
(*   UseDigest   FALSE: token is the tail only, first match wins           *)
(*   UseRev      FALSE: any snapshot may delete keys                       *)
(*   BlankKeeps  FALSE: blank input wipes the provider's keys              *)
(*   DropTokens  FALSE: an unresolved token is stored as if it were a key  *)
(***************************************************************************)
EXTENDS FiniteSets, Naturals

CONSTANTS p1, p2, Providers, Keys, TwinA, TwinB, Other, MaxSaves,
          SanitizeOn, UseDigest, UseRev, BlankKeeps, DropTokens

Tail(k) == IF k = Other THEN "other" ELSE "same"     \* TwinA, TwinB share a tail
Token(k) == IF UseDigest THEN [digest |-> k] ELSE [tail |-> Tail(k)]
Forged == [forged |-> "edited or unknown token"]

VARIABLES
    store,        \* [Providers -> SUBSET ...]  main process store
    seen,         \* store content when the renderer took its snapshot (keysRev + tokens)
    saves,        \* bound on submissions
    lost,         \* ghost: keys that left the store although the user did not delete them
    resurrected,  \* ghost: keys that entered the store without being typed in
    userDeleted,  \* ghost: some key was really deleted by the user (sanity)
    userAdded     \* ghost: some key was really added by the user (sanity)

vars == <<store, seen, saves, lost, resurrected, userDeleted, userAdded>>

\* src: src/config-keys.js sanitizeConfig
ViewOf(p) == IF SanitizeOn THEN {Token(k) : k \in seen[p]} ELSE seen[p]
AllViews == UNION {ViewOf(p) : p \in Providers}

Hits(q, t) == {k \in store[q] : Token(k) = t}

\* src: src/config-keys.js resolveList + mergeIncomingKeys
Merge(q, input) ==
    LET news       == input \cap Keys
        toks       == input \ Keys
        unresolved == {t \in toks : Hits(q, t) = {}}
        picked     == {CHOOSE k \in Hits(q, t) : TRUE : t \in toks \ unresolved}
        canRemove  == (~UseRev \/ seen = store) /\ unresolved = {}
    IN IF input = {}
       THEN (IF BlankKeeps THEN store[q] ELSE {})
       ELSE news \cup picked
                 \cup (IF canRemove THEN {} ELSE store[q])
                 \cup (IF DropTokens THEN {} ELSE unresolved)

\* What the user asked to delete: a stored key whose line was on screen and is gone.
\* Blank input is defined as "no change", so it deletes nothing.
Intended(q, input) ==
    IF input = {} THEN {}
    ELSE {k \in store[q] : (Token(k) \in ViewOf(q) \/ k \in ViewOf(q))
                           /\ Token(k) \notin input /\ k \notin input}

Init ==
    /\ store \in [Providers -> SUBSET Keys]
    /\ seen = store
    /\ saves = 0
    /\ lost = {}
    /\ resurrected = {}
    /\ userDeleted = FALSE
    /\ userAdded = FALSE

\* src: src/main.js config:set <- src/renderer/renderer.js saveSettings / setConfig({...config})
\* Provider p's row carries the user's edit: any tokens on screen (also another
\* provider's), new keys, an edited token, or nothing. Other rows round-trip their
\* held tokens, which is what the {...config} toggles do.
Save(p, input) ==
    /\ saves < MaxSaves
    /\ LET inputOf(q)  == IF q = p THEN input ELSE ViewOf(q)
           next        == [q \in Providers |-> Merge(q, inputOf(q))]
           gone(q)     == store[q] \ next[q]
           allowed(q)  == Intended(q, inputOf(q))
           came(q)     == next[q] \ store[q]
       IN /\ store' = next
          /\ lost' = lost \cup UNION {gone(q) \ allowed(q) : q \in Providers}
          /\ resurrected' = resurrected \cup UNION {came(q) \ inputOf(q) : q \in Providers}
          /\ userDeleted' = (userDeleted \/ \E q \in Providers : gone(q) \cap allowed(q) # {})
          /\ userAdded' = (userAdded \/ \E q \in Providers : came(q) \cap inputOf(q) \cap Keys # {})
    /\ saves' = saves + 1
    /\ UNCHANGED seen

\* src: src/renderer/renderer.js loadProviderChain / config = await setConfig(...)
Refresh ==
    /\ seen' = store
    /\ UNCHANGED <<store, saves, lost, resurrected, userDeleted, userAdded>>

Next ==
    \/ \E p \in Providers, s \in SUBSET AllViews, n \in SUBSET Keys, f \in SUBSET {Forged} :
          Save(p, s \cup n \cup f)
    \/ Refresh

Spec == Init /\ [][Next]_vars

\* ---- properties (the three asked for, plus no resurrection) ----
NoSilentLoss == lost = {}
NoTokenStored == \A p \in Providers : store[p] \subseteq Keys
ViewHasNoRawKey == AllViews \cap Keys = {}
NoResurrection == resurrected = {}

\* ---- sanity: must be violated, or the green run proves nothing ----
SanityNoDeletion == ~userDeleted
SanityNoAddition == ~userAdded
=============================================================================
