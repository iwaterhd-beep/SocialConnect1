-- Pégalo en SQL Editor y Run: ¿existe el usuario de login en Auth?
select id, email, email_confirmed_at, created_at
from auth.users
where email = 'admin@example.com';
