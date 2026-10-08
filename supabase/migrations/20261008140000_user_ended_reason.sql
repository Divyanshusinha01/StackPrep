-- Candidate-ended interviews (PRD section 21). Kept separate from the function that uses the
-- value: new enum values cannot be used in the transaction that adds them.

alter type public.termination_reason add value if not exists 'user_ended';
