/* database.js
   Tracker Hutang (Single-site Login)
   Storage: Firestore

   NEW:
   - requestToyyibPayBill(debtorId, amountRM, returnUrl)
     Calls Cloud Function to create a ToyyibPay Bill securely.

   Koleksi:
   debtors/{debtorId}
     - name, phone, note
     - totalDebt
     - totalPaid
     - balance
     - passwordSalt
     - passwordHash
     - createdAt, updatedAt

   Subkoleksi:
   debtors/{debtorId}/transactions/{txnId}
     - amount
     - provider: "manual" | "toyyibpay"
     - status: "success"
     - method?, reference?
     - billCode?, refno?, order_id?
     - createdAt

   debtors/{debtorId}/payment_requests/{reqId}
     - amount
     - status: "pending" | "created" | "success" | "fail"
     - billCode?
     - createdAt, updatedAt
*/

const DebtDB = (() => {
  let _fs = null;

  const now = () => new Date().toISOString();
  const uid = () =>
    "id_" + Math.random().toString(36).slice(2) + Date.now().toString(36);

  function initFirebase() {
    if (!firebase?.firestore) throw new Error("Firestore compat belum dimuatkan.");
    _fs = firebase.firestore();
  }

  function assertInit() {
    if (!_fs) throw new Error("DebtDB belum init. Panggil initFirebase().");
  }

  // ---------- Password Hashing (SHA-256 + salt) ----------
  function genSalt(len = 16) {
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let s = "";
    for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  async function sha256Hex(text) {
    const enc = new TextEncoder().encode(text);
    const buf = await crypto.subtle.digest("SHA-256", enc);
    return [...new Uint8Array(buf)]
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async function hashPassword(password, salt) {
    return sha256Hex(`${salt}:${password}`);
  }

  async function verifyPasswordLocal(debtorDoc, passwordInput) {
    const salt = debtorDoc?.passwordSalt;
    const hash = debtorDoc?.passwordHash;
    if (!salt || !hash) return false;
    const computed = await hashPassword(passwordInput, salt);
    return computed === hash;
  }

  // ---------- Debtors CRUD ----------
  async function createDebtor({
    name,
    phone = "",
    note = "",
    totalDebt,
    password,
    initialPaid = 0
  }) {
    assertInit();

    const debtorId = uid();
    const salt = genSalt();
    const passHash = await hashPassword(String(password || ""), salt);

    const debt = Math.max(0, Number(totalDebt) || 0);
    let paid = Math.max(0, Number(initialPaid) || 0);
    if (paid > debt) paid = debt;

    const doc = {
      id: debtorId,
      name: String(name || "").trim(),
      phone: String(phone || "").trim(),
      note: String(note || "").trim(),
      totalDebt: debt,
      totalPaid: paid,
      balance: Math.max(0, debt - paid),
      passwordSalt: salt,
      passwordHash: passHash,
      createdAt: now(),
      updatedAt: now()
    };

    const debtorRef = _fs.collection("debtors").doc(debtorId);
    await debtorRef.set(doc);

    if (paid > 0) {
      const txnRef = debtorRef.collection("transactions").doc(uid());
      await txnRef.set({
        id: txnRef.id,
        amount: paid,
        provider: "manual",
        status: "success",
        method: "Baki Awal",
        reference: "Rekod bayaran sedia ada semasa pendaftaran",
        createdAt: now()
      });
    }

    return doc;
  }

  async function updateDebtor(debtorId, patch = {}) {
    assertInit();

    const ref = _fs.collection("debtors").doc(debtorId);
    const snap = await ref.get();
    if (!snap.exists) return null;

    const cur = snap.data();

    const upd = {
      ...(patch.name !== undefined ? { name: String(patch.name).trim() } : {}),
      ...(patch.phone !== undefined ? { phone: String(patch.phone).trim() } : {}),
      ...(patch.note !== undefined ? { note: String(patch.note).trim() } : {}),
      ...(patch.totalDebt !== undefined ? { totalDebt: Math.max(0, Number(patch.totalDebt) || 0) } : {}),
      updatedAt: now()
    };

    const newTotalDebt =
      upd.totalDebt !== undefined ? upd.totalDebt : (Number(cur.totalDebt) || 0);
    const totalPaid = Number(cur.totalPaid) || 0;

    upd.balance = Math.max(0, newTotalDebt - totalPaid);

    await ref.update(upd);
    return { ...cur, ...upd };
  }

  async function resetDebtorPassword(debtorId, newPassword) {
    assertInit();
    const ref = _fs.collection("debtors").doc(debtorId);
    const salt = genSalt();
    const passHash = await hashPassword(String(newPassword || ""), salt);
    await ref.update({ passwordSalt: salt, passwordHash: passHash, updatedAt: now() });
    return true;
  }

  async function deleteDebtor(debtorId) {
    assertInit();
    await _fs.collection("debtors").doc(debtorId).delete();
    return true;
  }

  function watchDebtors(callback) {
    assertInit();
    return _fs.collection("debtors")
      .onSnapshot((qs) => {
        const list = qs.docs.map(d => d.data());
        callback(list);
      });
  }

  async function getDebtorOnce(debtorId) {
    assertInit();
    const snap = await _fs.collection("debtors").doc(debtorId).get();
    return snap.exists ? snap.data() : null;
  }

  function watchDebtor(debtorId, callback) {
    assertInit();
    return _fs.collection("debtors").doc(debtorId)
      .onSnapshot((snap) => callback(snap.exists ? snap.data() : null));
  }

  async function listTransactionsOnce(debtorId, limit = 100) {
    assertInit();
    const ref = _fs.collection("debtors").doc(debtorId).collection("transactions");
    const snap = await ref.orderBy("createdAt", "desc").limit(limit).get();
    return snap.docs.map(d => d.data());
  }

  // ---------- Manual payment by Admin ----------
  async function addManualPayment(debtorId, amount, method = "Tunai", reference = "") {
    assertInit();
    const amt = Math.max(0, Number(amount) || 0);
    if (!amt) throw new Error("Amaun tidak sah.");

    const debtorRef = _fs.collection("debtors").doc(debtorId);
    const txnRef = debtorRef.collection("transactions").doc(uid());

    await _fs.runTransaction(async (t) => {
      const snap = await t.get(debtorRef);
      if (!snap.exists) throw new Error("Penghutang tidak ditemui.");

      const d = snap.data();
      const totalDebt = Number(d.totalDebt) || 0;
      const totalPaid = (Number(d.totalPaid) || 0) + amt;
      const balance = Math.max(0, totalDebt - totalPaid);

      t.set(txnRef, {
        id: txnRef.id,
        amount: amt,
        provider: "manual",
        method,
        reference: String(reference || "").trim(),
        status: "success",
        createdAt: now()
      });

      t.update(debtorRef, { totalPaid, balance, updatedAt: now() });
    });

    return true;
  }

  // ---------- Debtor login helper (scan) ----------
  async function findDebtorByPassword(passwordInput, scanLimit = 200) {
    assertInit();
    const snap = await _fs.collection("debtors").limit(scanLimit).get();
    const list = snap.docs.map(d => d.data());

    for (const d of list) {
      const ok = await verifyPasswordLocal(d, passwordInput);
      if (ok) return d;
    }
    return null;
  }

  // ---------- ToyyibPay: request bill via Cloud Function ----------
  // You MUST update FUNCTION_REGION if you deploy to a different region.
  const FUNCTION_REGION = "asia-southeast1";

  function getProjectIdFromConfig() {
    try { return firebase.app().options.projectId; } catch { return ""; }
  }

  function getCreateBillFunctionUrl() {
    const pid = getProjectIdFromConfig();
    if (!pid) throw new Error("ProjectId tidak ditemui.");
    return `https://${FUNCTION_REGION}-${pid}.cloudfunctions.net/createToyyibBill`;
  }

  async function requestToyyibPayBill(debtorId, amountRM, returnUrl) {
    assertInit();
    const amt = Math.max(0, Number(amountRM) || 0);
    if (!amt) throw new Error("Amaun tidak sah.");

    const url = getCreateBillFunctionUrl();
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        debtorId,
        amount: amt,
        returnUrl: returnUrl || ""
      })
    });

    if (!res.ok) {
      let txt = "";
      try { txt = await res.text(); } catch {}
      throw new Error(txt || "Gagal cipta bil ToyyibPay.");
    }

    const data = await res.json();
    if (!data?.billCode || !data?.paymentUrl) {
      throw new Error("Respon bil tidak lengkap.");
    }
    return data;
  }

  // ---------- Stats ----------
  function computeStats(d) {
    const totalDebt = Number(d?.totalDebt) || 0;
    const totalPaid = Number(d?.totalPaid) || 0;
    const balRaw = Number(d?.balance);
    const balance = Number.isFinite(balRaw) ? balRaw : Math.max(0, totalDebt - totalPaid);
    const isSettled = totalDebt > 0 && balance <= 0;
    const pct = totalDebt > 0 ? Math.max(0, Math.min(100, (totalPaid / totalDebt) * 100)) : 0;
    return { totalDebt, totalPaid, balance, isSettled, pct };
  }

  return {
    initFirebase,
    createDebtor,
    updateDebtor,
    resetDebtorPassword,
    deleteDebtor,
    watchDebtors,
    getDebtorOnce,
    watchDebtor,
    listTransactionsOnce,
    addManualPayment,
    computeStats,
    verifyPasswordLocal,
    hashPassword,
    findDebtorByPassword,
    requestToyyibPayBill
  };
})();
