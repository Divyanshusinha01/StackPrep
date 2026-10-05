-- Integrity frame checks (PRD section 20). Kept separate from the functions and index that use the
-- value: new enum values cannot be used in the transaction that adds them.

alter type public.event_type add value if not exists 'integrity_check';
