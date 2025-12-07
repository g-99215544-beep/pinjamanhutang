const functions = require("firebase-functions");
const admin = require("firebase-admin");
const cors = require("cors")({ origin: true });

admin.initializeApp();
const db = admin.firestore();

// ======= ENV (JANGAN hardcode secret) =======
// Letakkan dalam functions/.env (atau guna Secret Manager)
const TP_SECRET = process.env.TOYYIBPAY_SECRET;
const TP_CATEGORY = process.env.TOYYIBPAY_CATEGORY || "n5j3i9gp";
const TP_BASE = process.env.TOYYIBPAY_BASE || "https://toyyibpay.com"; // production
const REGION = "asia-southeast1";

function assertEnv() {
  if (!TP_SECRET) throw new Error("Missing TOYYIBPAY_SECRET in env");
  if (!TP_CATEGORY) throw new Error("Missing TOYYIBPAY_CATEGORY in env");
}

function now() { return new Date().toISOString(); }

function toCent(amountRM) {
  const n = Number(amountRM) || 0;
  return Math.round(n * 100);
}

function buildCallbackUrl() {
  const projectId = process.env.GCLOUD_PROJECT;
  return `https://${REGION}-${projectId}.cloudfunctions.net/toyyibpayCallback`;
}

// order_id: DEBT-<debtorId>-<timestamp>
function parseOrderId(orderId) {
  if (!orderId) return null;
  const parts = String(orderId).split("-");
  if (parts.length < 3) return null;
  if (parts[0] !== "DEBT") return null;
  return parts[1];
}

async function tpCreateBill(payload) {
  const url = `${TP_BASE}/index.php/api/createBill`;
  const body = new URLSearchParams(payload);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }

  if (!res.ok || !Array.isArray(json) || !json[0]?.BillCode) {
    throw new Error(`ToyyibPay createBill error: ${text}`);
  }

  return json[0].BillCode;
}

async function tpGetBillTransactions(billCode) {
  const url = `${TP_BASE}/index.php/api/getBillTransactions`;
  const body = new URLSearchParams({
    billCode: billCode,
    billpaymentStatus: "1"
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }

  if (!res.ok || !Array.isArray(json)) {
    throw new Error(`ToyyibPay getBillTransactions error: ${text}`);
  }

  return json;
}

// ============================================
// 1) Create Bill endpoint (called by frontend)
// ============================================
exports.createToyyibBill = functions
  .region(REGION)
  .https.onRequest(async (req, res) => {
    cors(req, res, async () => {
      try {
        assertEnv();

        if (req.method !== "POST") {
          res.status(405).send("Method not allowed");
          return;
        }

        const { debtorId, amount, returnUrl } = req.body || {};
        if (!debtorId) throw new Error("Missing debtorId");
        const amt = Math.max(0, Number(amount) || 0);
        if (!amt) throw new Error("Invalid amount");

        const debtorRef = db.collection("debtors").doc(debtorId);
        const debtorSnap = await debtorRef.get();
        if (!debtorSnap.exists) throw new Error("Debtor not found");

        const d = debtorSnap.data();
        const balance = Math.max(0, Number(d.balance) || 0);
        if (balance <= 0) throw new Error("Debt already settled");
        if (amt > balance) throw new Error("Amount exceeds balance");

        const orderId = `DEBT-${debtorId}-${Date.now()}`;
        const callbackUrl = buildCallbackUrl();

        const prRef = debtorRef.collection("payment_requests").doc(orderId);
        await prRef.set({
          id: orderId,
          amount: amt,
          status: "pending",
          createdAt: now(),
          updatedAt: now()
        });

        const billCode = await tpCreateBill({
          userSecretKey: TP_SECRET,
          categoryCode: TP_CATEGORY,
          billName: (`Bayaran Hutang ${d.name || ""}`).slice(0, 30) || "Bayaran Hutang",
          billDescription: (`Bayaran hutang untuk ${d.name || "penghutang"}`).slice(0, 100) || "Bayaran hutang",
          billPriceSetting: "1",
          billPayorInfo: "0",
          billAmount: String(toCent(amt)),
          billReturnUrl: returnUrl || "",
          billCallbackUrl: callbackUrl,
          billExternalReferenceNo: orderId,
          billTo: d.name || "",
          billEmail: "",
          billPhone: d.phone || "",
          billSplitPayment: "0",
          billSplitPaymentArgs: "",
          billPaymentChannel: "0"
        });

        const paymentUrl = `${TP_BASE}/${billCode}`;

        await prRef.update({
          billCode,
          status: "created",
          updatedAt: now()
        });

        res.json({ billCode, paymentUrl, orderId });
      } catch (e) {
        res.status(400).send(e.message || "Error");
      }
    });
  });

// ============================================
// 2) Callback endpoint from ToyyibPay
// ============================================
exports.toyyibpayCallback = functions
  .region(REGION)
  .https.onRequest(async (req, res) => {
    try {
      assertEnv();

      const body = req.body || {};

      const status = String(body.status ?? "");
      const billcode = String(body.billcode ?? "");
      const order_id = String(body.order_id ?? body.orderId ?? body.billExternalReferenceNo ?? "");
      const refno = String(body.refno ?? "");
      const amountStr = String(body.amount ?? "0");
      const trxTime = String(body.transaction_time ?? "");

      if (!billcode) {
        res.status(200).send("OK");
        return;
      }

      // Not success
      if (status !== "1") {
        const debtorId = parseOrderId(order_id);
        if (debtorId) {
          const prRef = db.collection("debtors").doc(debtorId)
            .collection("payment_requests").doc(order_id);
          await prRef.set({
            id: order_id,
            billCode: billcode,
            status: status === "3" ? "fail" : "pending",
            updatedAt: now()
          }, { merge: true });
        }
        res.status(200).send("OK");
        return;
      }

      const debtorId = parseOrderId(order_id);
      if (!debtorId) {
        res.status(200).send("OK");
        return;
      }

      let verifiedAmount = null;
      try {
        const txns = await tpGetBillTransactions(billcode);
        if (txns?.[0]?.billpaymentStatus === "1") {
          const a = Number(txns[0]?.billpaymentAmount);
          if (Number.isFinite(a)) verifiedAmount = a;
        }
      } catch (e) {
        // ignore verification errors
      }

      const amountRM = verifiedAmount ?? (Number(amountStr) || 0);
      if (!amountRM) {
        res.status(200).send("OK");
        return;
      }

      const debtorRef = db.collection("debtors").doc(debtorId);
      const txnId = `toyyib_${billcode}`; // idempotent
      const txnRef = debtorRef.collection("transactions").doc(txnId);
      const prRef = debtorRef.collection("payment_requests").doc(order_id);

      await db.runTransaction(async (t) => {
        const dSnap = await t.get(debtorRef);
        if (!dSnap.exists) return;

        const existingTxn = await t.get(txnRef);
        if (existingTxn.exists) {
          t.set(prRef, {
            id: order_id,
            billCode: billcode,
            status: "success",
            updatedAt: now()
          }, { merge: true });
          return;
        }

        const d = dSnap.data();
        const totalDebt = Number(d.totalDebt) || 0;
        const prevPaid = Number(d.totalPaid) || 0;

        const prevBalance = Math.max(0, Number(d.balance) || Math.max(0, totalDebt - prevPaid));
        const credit = Math.min(amountRM, prevBalance);

        const totalPaid = prevPaid + credit;
        const balance = Math.max(0, totalDebt - totalPaid);

        t.set(txnRef, {
          id: txnId,
          amount: credit,
          provider: "toyyibpay",
          status: "success",
          method: "FPX",
          reference: refno || "",
          billCode: billcode,
          order_id,
          transaction_time: trxTime,
          createdAt: now()
        });

        t.set(prRef, {
          id: order_id,
          amount: amountRM,
          credited: credit,
          billCode: billcode,
          status: "success",
          updatedAt: now()
        }, { merge: true });

        t.update(debtorRef, {
          totalPaid,
          balance,
          updatedAt: now()
        });
      });

      res.status(200).send("OK");
    } catch (e) {
      // return 200 to avoid excessive retries
      res.status(200).send("OK");
    }
  });
