/**
 * pump.fun Creator Fee Claim Tracker
 * ------------------------------------
 * Telegram bot UI to manage watched wallets with names.
 * Detects creator fee claims and sends: creator name + token CA.
 *
 * Commands:
 *   /add             — start wizard to add a wallet (asks for address then name)
 *   /remove <wallet> — stop watching a wallet
 *   /list            — show all watched wallets
 *
 * Usage:
 *   node tracker.js                        → live mode
 *   node tracker.js test <TX_SIGNATURE>    → test a known transaction
 */

import { Connection, PublicKey } from "@solana/web3.js";
import fetch from "node-fetch";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();

// ─── Config ────────────────────────────────────────────────────────────────

const RPC_WS   = process.env.SOLANA_WS_URL;
const RPC_HTTP = process.env.SOLANA_RPC_URL;

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
// Group chat ID — fee alerts are sent here. Commands work from anyone.
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT_ID;

const WALLETS_FILE = "./wallets.json";

// ─── Program IDs ───────────────────────────────────────────────────────────

// Both pump.fun program IDs that can emit fee claim instructions
const PUMP_PROGRAM_IDS = new Set([
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", // Bonding curve
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", // PumpSwap AMM
  "FEEhPbKVKnco9EXnaY3i4R5rQVUx91wgVfu8qokixywi", // BAGS
]);

// Match any log containing "reatorFee" — covers all known variants:
//   "DistributeCreatorFees", "Distribute_creator_fees", "TransferCreatorFeesToPump"
const FEE_LOG_SIGNATURES = [
  "claim_trading_fee",       // bags
  "DistributeCreatorFees",   // pump
  "TransferCreatorFeesToPump", // pump
  "ClaimSocialFeePda",       // pump
];

// ─── Wallet Storage ─────────────────────────────────────────────────────────
// wallets.json format: [ { address, name }, ... ]

function loadWallets() {
  if (!fs.existsSync(WALLETS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(WALLETS_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveWallets(wallets) {
  fs.writeFileSync(WALLETS_FILE, JSON.stringify(wallets, null, 2));
}

function addWallet(address, name) {
  const wallets = loadWallets();
  if (wallets.some(w => w.address === address)) return false;
  wallets.push({ address, name });
  saveWallets(wallets);
  return true;
}

function removeWallet(address) {
  const wallets = loadWallets();
  const filtered = wallets.filter(w => w.address !== address);
  if (filtered.length === wallets.length) return false;
  saveWallets(filtered);
  return true;
}

function getWalletName(address) {
  const wallets = loadWallets();
  return wallets.find(w => w.address === address)?.name || address.slice(0, 8) + "…";
}

// ─── Add Wizard State ───────────────────────────────────────────────────────
// Tracks users mid-way through the /add flow
// pendingAdd[userId] = { step: "waiting_address" | "waiting_name", address? }
const pendingAdd = new Map();

// ─── Active Subscriptions ───────────────────────────────────────────────────
const activeSubscriptions = new Map();

// ─── Helpers ────────────────────────────────────────────────────────────────

async function sendTelegram(text, chatId = TELEGRAM_CHAT) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
      }),
    });
    const json = await res.json();
    if (!json.ok) {
      console.error(`❌ Telegram error: ${json.error_code} — ${json.description}`);
      console.error(`   chat_id used: ${chatId}`);
    }
  } catch (e) {
    console.error(`❌ Telegram fetch failed:`, e.message);
  }
}

function isValidSolanaAddress(addr) {
  try {
    new PublicKey(addr);
    return true;
  } catch {
    return false;
  }
}

async function extractTokenCA(tx, connection) {
  const accounts = tx.transaction.message.accountKeys.map(k =>
    typeof k === "object" && k.pubkey ? k.pubkey.toBase58() : (typeof k === "string" ? k : k.toBase58())
  );

  for (const addr of accounts.slice(1)) {
    try {
      const info = await connection.getParsedAccountInfo(new PublicKey(addr));
      const data = info?.value?.data;
      if (data && typeof data === "object" && data.parsed?.type === "mint") {
        return addr;
      }
    } catch {
      // skip
    }
  }
  return null;
}

async function detectFeeClaim(tx, connection) {
  if (!tx || tx.meta?.err) return null;

  const accounts = tx.transaction.message.accountKeys.map(k =>
    typeof k === "object" && k.pubkey ? k.pubkey.toBase58() : (typeof k === "string" ? k : k.toBase58())
  );
  const txLogs = tx.meta?.logMessages || [];

  const involvesPump = accounts.some(a => PUMP_PROGRAM_IDS.has(a));
const hasFeeLog = txLogs.some(l => FEE_LOG_SIGNATURES.some(sig => l.includes(sig)));

  if (involvesPump && hasFeeLog) {
    return await extractTokenCA(tx, connection);
  }
  return null;
}

// ─── Subscriptions ──────────────────────────────────────────────────────────

function subscribeWallet(wallet, connection) {
  if (activeSubscriptions.has(wallet)) return;

  const pubkey = new PublicKey(wallet);
  const subIds = [];

  const subId = connection.onLogs(
    pubkey,
    async ({ signature, err, logs }) => {
      if (err) return;

      const mightBeClaim = logs.some(l => FEE_LOG_SIGNATURES.some(sig => l.includes(sig)));
      if (!mightBeClaim) return;

      try {
        const tx = await connection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        });

        const tokenCA = await detectFeeClaim(tx, connection);
        if (!tokenCA) return;

        const name = getWalletName(wallet);
        console.log(`✅ Fee claim! [${name}] Token CA: ${tokenCA}`);
        await sendTelegram(`👤 <b>${name}</b>\n<code>${tokenCA}</code>`);
      } catch (e) {
        console.error(`Error processing TX ${signature}:`, e.message);
      }
    },
    "confirmed"
  );
  subIds.push(subId);

  activeSubscriptions.set(wallet, subIds);
  console.log(`👁  Subscribed: ${wallet}`);
}

async function unsubscribeWallet(wallet, connection) {
  const subIds = activeSubscriptions.get(wallet);
  if (!subIds) return;
  for (const id of subIds) {
    try { await connection.removeOnLogsListener(id); } catch {}
  }
  activeSubscriptions.delete(wallet);
  console.log(`🛑 Unsubscribed: ${wallet}`);
}

// ─── Telegram Bot (polling) ─────────────────────────────────────────────────

let lastUpdateId = 0;

async function pollTelegram(connection) {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`
    );
    const data = await res.json();

    for (const update of data.result || []) {
      lastUpdateId = update.update_id;
      const msg = update.message;
      if (!msg || !msg.text) continue;

      const chatId   = msg.chat.id.toString();
      const userId   = msg.from.id.toString();
      const text     = msg.text.trim();
      const [cmd, arg] = text.split(/\s+/);

      // ── Handle wizard steps first ──────────────────────────────────────
      if (pendingAdd.has(userId)) {
        const state = pendingAdd.get(userId);

        if (state.step === "waiting_address") {
          if (!isValidSolanaAddress(text)) {
            await sendTelegram("❌ Invalid Solana address. Try again or send /cancel", chatId);
            continue;
          }
          if (loadWallets().some(w => w.address === text)) {
            await sendTelegram(`⚠️ Already watching that wallet.`, chatId);
            pendingAdd.delete(userId);
            continue;
          }
          pendingAdd.set(userId, { step: "waiting_name", address: text, chatId });
          await sendTelegram(`Got it! Now send a <b>name</b> for this wallet (e.g. Ansem, Tate, etc.)`, chatId);
          continue;
        }

        if (state.step === "waiting_name") {
          const name    = text.slice(0, 32); // cap name length
          const address = state.address;
          pendingAdd.delete(userId);
          addWallet(address, name);
          subscribeWallet(address, connection);
          await sendTelegram(
            `✅ Now watching:\n👤 <b>${name}</b>\n<code>${address}</code>`,
            chatId
          );
          continue;
        }
      }

      // ── Commands ───────────────────────────────────────────────────────
      switch (cmd) {
        case "/add": {
          pendingAdd.set(userId, { step: "waiting_address", chatId });
          await sendTelegram("Send the <b>wallet address</b> you want to watch:", chatId);
          break;
        }

        case "/cancel": {
          if (pendingAdd.has(userId)) {
            pendingAdd.delete(userId);
            await sendTelegram("❌ Cancelled.", chatId);
          }
          break;
        }

        case "/remove": {
          if (!arg) {
            await sendTelegram("Usage: /remove <wallet_address>", chatId);
            break;
          }
          const removed = removeWallet(arg);
          if (!removed) {
            await sendTelegram(`⚠️ Wallet not found:\n<code>${arg}</code>`, chatId);
          } else {
            await unsubscribeWallet(arg, connection);
            await sendTelegram(`🛑 Stopped watching <code>${arg}</code>`, chatId);
          }
          break;
        }

        case "/list": {
          const wallets = loadWallets();
          if (wallets.length === 0) {
            await sendTelegram("📭 No wallets being watched.", chatId);
          } else {
            const lines = wallets
              .map((w, i) => `${i + 1}. 👤 <b>${w.name}</b>\n    <code>${w.address}</code>`)
              .join("\n\n");
            await sendTelegram(`👁 <b>Watched wallets (${wallets.length}):</b>\n\n${lines}`, chatId);
          }
          break;
        }

        case "/test": {
          const knownTx = "5VKhtPCuxWHGtzbT5GjZ2ZUFnZxMXsKKSWjjJ8muhrSxVHK1aJ54A81qpQ5BSbvrftmSk4byt9qZ3nYCo4rYazGd";
          await sendTelegram(`🧪 Running test...`, chatId);
          try {
            const tx = await connection.getParsedTransaction(knownTx, {
              maxSupportedTransactionVersion: 0,
              commitment: "confirmed",
            });
            const tokenCA = await detectFeeClaim(tx, connection);
            if (tokenCA) {
              await sendTelegram(`✅ <b>Test passed!</b>\n👤 <b>HUNTER</b>\n<code>${tokenCA}</code>`, chatId);
            } else {
              await sendTelegram(`❌ Test failed — tx not detected as fee claim.`, chatId);
            }
          } catch (e) {
            await sendTelegram(`❌ Test error: ${e.message}`, chatId);
          }
          break;
        }

        case "/start":
        case "/help": {
          await sendTelegram(
            `<b>pump.fun Fee Tracker</b>\n\n` +
            `/add — watch a new wallet (wizard)\n` +
            `/remove &lt;wallet&gt; — stop watching\n` +
            `/list — show all watched wallets\n` +
            `/test — test Telegram notifications\n` +
            `/cancel — cancel current action`,
            chatId
          );
          break;
        }

        default:
          // Ignore unknown messages silently in groups
          break;
      }
    }
  } catch (e) {
    console.error("Telegram poll error:", e.message);
  }

  setTimeout(() => pollTelegram(connection), 1000);
}

// ─── Test Mode ──────────────────────────────────────────────────────────────

async function runTest(signature, connection) {
  console.log("\n🧪 TEST MODE");
  console.log(`🔍 Fetching transaction: ${signature}\n`);

  const tx = await connection.getParsedTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });

  if (!tx) {
    console.error("❌ Transaction not found.");
    process.exit(1);
  }

  console.log(`   Status: ${tx.meta?.err ? "FAILED" : "SUCCESS"}`);
  console.log(`   Logs:`);
  (tx.meta?.logMessages || []).forEach(l => console.log(`     ${l}`));
  console.log();

  const tokenCA = await detectFeeClaim(tx, connection);

  if (!tokenCA) {
    console.log("⚠️  Not detected as a fee claim transaction.");
    process.exit(1);
  }

  console.log(`✅ Fee claim detected!`);
  console.log(`🪙 Token CA: ${tokenCA}\n`);

  if (TELEGRAM_TOKEN && TELEGRAM_CHAT) {
    console.log("📬 Sending Telegram notification…");
    await sendTelegram(`🧪 <b>[TEST]</b>\n<code>${tokenCA}</code>`);
    console.log("✅ Telegram message sent!\n");
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const isTestMode = args[0] === "test";
  const testSignature = args[1];

  if (!TELEGRAM_TOKEN) {
    console.error("❌  Missing TELEGRAM_BOT_TOKEN in .env");
    process.exit(1);
  }
  if (!RPC_HTTP || !RPC_WS) {
    console.error("❌  Missing SOLANA_RPC_URL or SOLANA_WS_URL in .env");
    process.exit(1);
  }

  const connection = new Connection(RPC_HTTP, {
    wsEndpoint: RPC_WS,
    commitment: "confirmed",
  });

  if (isTestMode) {
    if (!testSignature) {
      console.error("❌  Usage: node tracker.js test <TX_SIGNATURE>");
      process.exit(1);
    }
    await runTest(testSignature, connection);
    process.exit(0);
  }

  console.log("🚀 Fee Claim Tracker starting…");
  const wallets = loadWallets();
  if (wallets.length === 0) {
    console.log("📭 No wallets yet. Use /add in Telegram to add one.\n");
  } else {
    for (const { address } of wallets) {
      subscribeWallet(address, connection);
    }
  }

  pollTelegram(connection);
  console.log("🤖 Telegram bot active. Use /help in your chat for commands.\n");

  process.on("SIGINT", () => {
    console.log("\n👋 Stopped.");
    process.exit(0);
  });
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
