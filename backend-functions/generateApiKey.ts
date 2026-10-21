import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);

  const masterKey = Deno.env.get("MSE_API_KEY");
  const providedKey = req.headers.get("x-master-key");

  if (!masterKey) {
    return new Response(JSON.stringify({
      error: "MSE_API_KEY secret not configured. Set it in the agent editor secrets."
    }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

  if (providedKey !== masterKey) {
    return new Response(JSON.stringify({
      error: "Unauthorized — invalid master key"
    }), { status: 401, headers: { "Content-Type": "application/json" } });
  }

  let body: any = {};
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({
      error: "Request body must be JSON"
    }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  const { app_name, contact_email } = body;
  if (!app_name) {
    return new Response(JSON.stringify({
      error: "app_name is required"
    }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  const apiKey = "mse_" + crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").substring(0, 8);

  try {
    const record = await base44.asServiceRole.entities.MseApiKey.create({
      api_key: apiKey,
      app_name,
      contact_email: contact_email || "",
      is_active: true,
      requests_count: 0,
    });

    return new Response(JSON.stringify({
      success: true,
      api_key: apiKey,
      app_name,
      contact_email: contact_email || "",
      is_active: true,
      created_date: record.created_date,
      message: "Save this API key securely. Pass it in the 'x-api-key' header when calling MSE data endpoints."
    }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({
      error: "Failed to generate API key: " + err.message
    }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
