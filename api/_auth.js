/**
 * Gestor Caldas — confere se a chamada vem do dono logado no app.
 * O app manda o token do Supabase Auth em "Authorization: Bearer <token>".
 */

// Único usuário do app (mesmo da política RLS "dono" do gestor_data)
export const DONO_ID = process.env.CENTRAL_DONO_ID || '3e9e15d3-d248-4733-8855-3eee637fbcb2';

export async function donoLogado(req, fetchFn = fetch) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  const auth = req.headers?.authorization || '';
  if (!auth.startsWith('Bearer ') || auth.length < 20 || !SUPABASE_URL || !SUPABASE_KEY) return false;
  try {
    const r = await fetchFn(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_KEY, Authorization: auth },
    });
    if (!r.ok) return false;
    const u = await r.json().catch(() => null);
    return u?.id === DONO_ID;
  } catch {
    return false;
  }
}
