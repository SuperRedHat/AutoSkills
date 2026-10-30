# deploy-kit fixtures

Hand-written synthetic trees for tests/kit/deploy-kit.test.mjs. The tests copy them into OS temp dirs
and pass --home, --runtime and --projects-root there. Nothing here is copied from a real user directory.

- home/: a fake user directory with old project-* skill copies in every legacy location, other skills that
  must stay, the three old agents, a brace-expansion folder, never-touch files and an old workflow-rules.md.
- projects/: two fake projects that register read-only folders in their rules (the contract line and the
  table form) plus folders that must not be picked up.
