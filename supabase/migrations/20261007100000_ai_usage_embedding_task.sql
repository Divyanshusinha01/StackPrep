-- Usage task for repository memory and search query embeddings. Kept alone: new enum values
-- cannot be used in the transaction that adds them.

alter type public.ai_task add value if not exists 'embedding';
