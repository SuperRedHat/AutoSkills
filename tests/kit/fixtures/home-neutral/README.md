# check-kit fixture: neutral profile in place

Laid on top of ../home-ok/ (see its README), as `deploy-kit --neutral --apply` leaves it: the three contract
files hold only the neutral line, the kit skills are not in home/.claude/skills or home/.agents/skills, and
the synthetic neutral journal deploy/20261030-080000-a1b2/journal.json (next to local.json, so in the
deploy root of that local config) is still applied. Agent definition, hooks and settings stay as deployed.

Expected: the neutral row is the only FAIL in strict mode, and it names
`--rollback 20261030-080000-a1b2`; under --report-only it is a WARN and nothing is a FAIL. The contract and
kit skill rows are left out while the neutral is in place.
