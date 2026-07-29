ALTER TABLE signing_keys DROP CONSTRAINT IF EXISTS signing_keys_algorithm_check;
ALTER TABLE signing_keys
  ADD CONSTRAINT signing_keys_algorithm_check CHECK (algorithm IN ('HS256', 'RS256'));
