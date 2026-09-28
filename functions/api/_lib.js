export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export function checkAuth(request, env) {
  const pw = request.headers.get("x-app-password") || "";
  return !!env.APP_PASSWORD && pw === env.APP_PASSWORD;
}
