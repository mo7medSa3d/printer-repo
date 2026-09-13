-- Keep tenant membership roles inside the authorization vocabulary.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_users_role_check') THEN
    ALTER TABLE "tenant_users"
      ADD CONSTRAINT "tenant_users_role_check"
      CHECK (role IN ('owner','admin','operator','viewer','integration_admin','billing_admin'));
  END IF;
END $$;
