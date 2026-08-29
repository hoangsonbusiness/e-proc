BEGIN;

-- Existing batch choices remain untouched. This changes only the default for
-- batches created after the administrator switched the policy default off.
ALTER TABLE public.batches
  ALTER COLUMN vmware_check_enabled SET DEFAULT FALSE;

COMMIT;
