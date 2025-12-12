-- Drop FK on profiles
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_user_id_fkey;