// netlify/functions/pix-webhook.js
// ============================================================
// Recebe a notificação de pagamento PIX confirmado
// Compatible com: Mercado Pago, Asaas, EfiBank, PrimePag
// ============================================================

const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // chave service_role (nunca exponha no frontend)
);

// Gera token seguro de 32 bytes
function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

// Monta a URL de acesso que será enviada ao lead
function buildAccessUrl(token) {
  return `${process.env.SITE_URL}?token=${token}`;
}

// ── Parsers por gateway ──────────────────────────────────────

function parseMercadoPago(body) {
  // MP envia: { action: "payment.updated", data: { id } }
  // A confirmação real exige buscar o pagamento pela API deles
  if (body.action !== "payment.updated") return null;
  return {
    paymentId: String(body.data?.id),
    status: null, // precisa buscar na API do MP
  };
}

function parseAsaas(body) {
  // Asaas envia: { event: "PAYMENT_RECEIVED", payment: { id, status, value, customer } }
  if (!["PAYMENT_RECEIVED", "PAYMENT_CONFIRMED"].includes(body.event)) return null;
  return {
    paymentId: body.payment?.id,
    status: "approved",
    amount: body.payment?.value,
    payerEmail: body.payment?.billingType === "PIX" ? body.payment?.customer : null,
    payerName: body.payment?.customer,
  };
}

function parseEfiBank(body) {
  // EfiBank: { pix: [{ endToEndId, txid, valor, horario, infoPagador }] }
  const pix = body.pix?.[0];
  if (!pix) return null;
  return {
    paymentId: pix.endToEndId || pix.txid,
    status: "approved",
    amount: parseFloat(pix.valor),
    payerName: pix.infoPagador,
  };
}

function parsePrimePag(body) {
  // PrimePag: { status: "PAID", transactionId, amount, customer: { email, name } }
  if (body.status !== "PAID") return null;
  return {
    paymentId: body.transactionId,
    status: "approved",
    amount: body.amount,
    payerEmail: body.customer?.email,
    payerName: body.customer?.name,
  };
}

function parseSyncPayments(body) {
  // SyncPayments OnUpdate: { data: { id, status: "completed", amount, final_amount, client: { name, email, document }, debtor_account, end_to_end } }
  // Header: event: cashin.update
  const d = body.data;
  if (!d) return null;
  if (d.status !== "completed") return null;
  return {
    paymentId: d.id,
    status: "approved",
    amount: d.final_amount ?? d.amount,
    payerEmail: d.client?.email,
    payerName: d.debtor_account?.name || d.client?.name,
  };
}

// ── Handler principal ────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  // Detecta gateway pelo header ou pelo conteúdo
  const gateway = event.headers["x-gateway"] || detectGateway(body);
  let parsed = null;

  switch (gateway) {
    case "asaas":     parsed = parseAsaas(body); break;
    case "efibank":   parsed = parseEfiBank(body); break;
    case "primepag":  parsed = parsePrimePag(body); break;
    case "syncpay":   parsed = parseSyncPayments(body); break;
    case "mercadopago": parsed = parseMercadoPago(body); break;
    default:
      // Fallback genérico: aceita { status: "approved", paymentId, amount }
      if (body.status === "approved" && body.paymentId) {
        parsed = body;
      }
  }

  if (!parsed || parsed.status !== "approved") {
    return { statusCode: 200, body: JSON.stringify({ skipped: true }) };
  }

  // Evita duplicata: verifica se já existe token para esse pagamento
  const { data: existing } = await supabase
    .from("access_tokens")
    .select("id, token")
    .eq("payment_id", parsed.paymentId)
    .maybeSingle();

  if (existing) {
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, token: existing.token, duplicate: true }),
    };
  }

  // Cria novo token
  const token = generateToken();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 365); // acesso por 1 ano

  const { error } = await supabase.from("access_tokens").insert({
    token,
    payment_id: parsed.paymentId,
    payer_email: parsed.payerEmail || null,
    payer_name: parsed.payerName || null,
    amount: parsed.amount || null,
    expires_at: expiresAt.toISOString(),
  });

  if (error) {
    console.error("Supabase insert error:", error);
    return { statusCode: 500, body: "DB error" };
  }

  const accessUrl = buildAccessUrl(token);
  console.log(`✅ Acesso liberado | payment: ${parsed.paymentId} | url: ${accessUrl}`);

  // Aqui você pode chamar um webhook de envio de mensagem (WhatsApp/email)
  // await sendWhatsApp(parsed.payerPhone, accessUrl);

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, token, accessUrl }),
  };
};

function detectGateway(body) {
  if (body.action?.startsWith("payment")) return "mercadopago";
  if (body.event?.startsWith("PAYMENT_")) return "asaas";
  if (body.pix) return "efibank";
  if (body.transactionId && body.status === "PAID") return "primepag";
  if (body.data?.id && body.data?.status) return "syncpay"; // SyncPayments: { data: { id, status } }
  return "generic";
}
