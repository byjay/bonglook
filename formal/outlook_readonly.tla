-------------------------- MODULE outlook_readonly --------------------------
(***************************************************************************)
(* Read-only gate in front of PowerShell spawn. Models runPowerShell in    *)
(* src/outlook.js: every call goes through checkReadOnlyScript, and only   *)
(* a script judged clean reaches spawn. Calls interleave freely.           *)
(*                                                                         *)
(* Limit: this model does NOT prove the string judgement. Classified is a  *)
(* constant standing for what checkReadOnlyScript returns, and the normal  *)
(* config assumes Classified = Forbidden. Whether the tokenizer computes   *)
(* that set for real scripts is covered by scripts/test-outlook-readonly   *)
(* .cjs (--oracle compares against the real PowerShell parser), and        *)
(* deliberate bypasses listed in outlook.js are outside Forbidden here.    *)
(* MC_ro_bug_classifier.cfg shows the invariant depends on that assumption.*)
(***************************************************************************)
EXTENDS FiniteSets

CONSTANTS
  Scripts,          \* scripts the module may ask to run
  Forbidden,        \* scripts that really contain a forbidden call
  Classified,       \* scripts checkReadOnlyScript rejects
  GateOn,           \* FALSE models removing the guard call
  RejectAsSuccess   \* TRUE models a refusal reported as success

ASSUME Forbidden \subseteq Scripts /\ Classified \subseteq Scripts
ASSUME GateOn \in BOOLEAN /\ RejectAsSuccess \in BOOLEAN

VARIABLES phase, spawned

vars == <<phase, spawned>>

Phases == {"idle", "approved", "rejected", "running", "doneOk", "doneErr"}

TypeOK ==
  /\ phase \in [Scripts -> Phases]
  /\ spawned \subseteq Scripts

Init ==
  /\ phase = [s \in Scripts |-> "idle"]
  /\ spawned = {}

\* The check and the spawn are separate steps so other calls can interleave.
Check(s) ==
  /\ phase[s] = "idle"
  /\ phase' = [phase EXCEPT ![s] =
       IF GateOn /\ s \in Classified THEN "rejected" ELSE "approved"]
  /\ UNCHANGED spawned

Spawn(s) ==
  /\ phase[s] = "approved"
  /\ phase' = [phase EXCEPT ![s] = "running"]
  /\ spawned' = spawned \cup {s}

Finish(s) ==
  /\ phase[s] = "running"
  /\ phase' = [phase EXCEPT ![s] = "doneOk"]
  /\ UNCHANGED spawned

Refuse(s) ==
  /\ phase[s] = "rejected"
  /\ phase' = [phase EXCEPT ![s] = IF RejectAsSuccess THEN "doneOk" ELSE "doneErr"]
  /\ UNCHANGED spawned

\* The same script text can be requested again later.
Again(s) ==
  /\ phase[s] \in {"doneOk", "doneErr"}
  /\ phase' = [phase EXCEPT ![s] = "idle"]
  /\ UNCHANGED spawned

Next == \E s \in Scripts : Check(s) \/ Spawn(s) \/ Finish(s) \/ Refuse(s) \/ Again(s)

Spec == Init /\ [][Next]_vars

\* The safety goal: a script with a forbidden call is never spawned.
NoForbiddenSpawn == spawned \cap Forbidden = {}

\* No false success: "doneOk" only for a script that really ran.
NoFalseSuccess == \A s \in Scripts : phase[s] = "doneOk" => s \in spawned

\* No false block: legitimate scripts, including ones whose data merely
\* mentions a forbidden name, are never refused.
NoFalseBlock == \A s \in Scripts \ Forbidden : phase[s] \notin {"rejected", "doneErr"}

\* Sanity (must be violated): clean scripts really do reach spawn.
CleanNeverSpawned == spawned \ Forbidden = {}

\* Sanity (must be violated): refusals really do happen.
NothingRefused == \A s \in Scripts : phase[s] # "doneErr"

=============================================================================
