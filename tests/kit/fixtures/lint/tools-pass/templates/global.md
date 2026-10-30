# Synthetic template

todo -> in_progress -> auto_verified -> done                        (acceptance_mode=auto)
todo -> in_progress -> auto_verified -> awaiting_manual_acceptance  (acceptance_mode=milestone_manual and stage_gate=true)
done / cancelled / superseded --reopen_task(reason, to_status?)--> todo | in_progress
todo -> in_progress <!-- added in batch one -->
<!-- a note that runs on to
the next line --> todo -> done

- `acceptance_mode: auto | manual | milestone_manual`
- `acceptance_mode == "manual"` waits for a person.
