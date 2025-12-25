/* Free Soak Any Attribute (SWADE House Rule)
 * - Intercepts the SWADE damage chat card "Soak" button
 * - Prompts for Attribute
 * - Rolls chosen Attribute
 * - Reduces wounds on the Actor (no Benny spent)
 *
 * Notes:
 * This is intentionally defensive because SWADE’s internal flags can vary by version/module stack.
 * It tries multiple ways to find the actor and the “pending wounds” number.
 */

const MODULE_ID = "free-soak-any-attr";

Hooks.once("init", () => {
  console.log(`[${MODULE_ID}] Initializing`);
});

Hooks.on("renderChatMessage", (message, html) => {
  // Only operate in SWADE worlds
  if (game.system?.id !== "swade") return;

  // Find candidate "Soak" buttons in this chat message.
  // SWADE cards (and many add-ons) usually have a button with dataset.action/operation containing 'soak'
  // or visible text containing "Soak".
  const buttons = html.find("button");

  for (const btnEl of buttons) {
    const btn = btnEl instanceof HTMLElement ? btnEl : btnEl[0];
    if (!btn) continue;

    const label = (btn.textContent || "").trim().toLowerCase();
    const action = (btn.dataset.action || btn.dataset.operation || "").toLowerCase();

    const looksLikeSoak =
      action.includes("soak") ||
      label === "soak" ||
      label.includes("soak");

    if (!looksLikeSoak) continue;

    // Avoid double-binding if chat re-renders
    if (btn.dataset.freeSoakBound === "1") continue;
    btn.dataset.freeSoakBound = "1";

    btn.addEventListener("click", async (ev) => {
      // Let GM keep default behavior if they hold Shift (escape hatch)
      if (ev.shiftKey) return;

      ev.preventDefault();
      ev.stopPropagation();

      try {
        await handleFreeSoak({ message, button: btn });
      } catch (err) {
        console.error(`[${MODULE_ID}] Soak failed:`, err);
        ui.notifications?.error("Free Soak module: failed. See console (F12) for details.");
      }
    }, true);
  }
});

async function handleFreeSoak({ message, button }) {
  // Attempt to resolve actor
  const actor = await resolveActorFromContext({ message, button });
  if (!actor) {
    ui.notifications?.warn("Free Soak module: Could not find the damaged actor for this Soak.");
    console.warn(`[${MODULE_ID}] Could not resolve actor`, { message, buttonDataset: button?.dataset });
    return;
  }

  // Attempt to resolve pending wounds from the message or button dataset.
  // If we can’t find it, we still allow a soak roll and just apply reduction as a “wounds to remove” prompt.
  const pendingWounds = resolvePendingWounds({ message, button, actor });

  const chosenAttr = await promptForAttribute(actor);
  if (!chosenAttr) return; // cancelled

  // Roll chosen attribute (best-effort for SWADE)
  const roll = await rollAttribute(actor, chosenAttr);

  const total = Number(roll?.total ?? roll?.result ?? NaN);
  const soaked = computeSoakFromTotal(total);

  // Apply wound reduction.
  // We assume the damage was already applied (per your request: after damage is applied),
  // so we reduce existing wounds by how many were soaked (capped by pendingWounds if known).
  const currentWounds = Number(foundry.utils.getProperty(actor, "system.wounds.value") ?? 0);

  const maxReducible = Number.isFinite(pendingWounds) ? pendingWounds : soaked;
  const reduceBy = Math.min(soaked, Math.max(maxReducible, 0), currentWounds);

  const newWounds = Math.max(currentWounds - reduceBy, 0);
  await actor.update({ "system.wounds.value": newWounds });

  // Post a small summary to chat
  const attrLabel = attributeLabel(chosenAttr);
  const pendingText = Number.isFinite(pendingWounds) ? ` (pending: ${pendingWounds})` : "";
  const content = `
    <div class="swade">
      <h3>Soak (House Rule)</h3>
      <p><b>${actor.name}</b> rolls <b>${attrLabel}</b>${pendingText}: <b>${Number.isFinite(total) ? total : "?"}</b></p>
      <p>Soaked: <b>${soaked}</b> | Wounds reduced: <b>${reduceBy}</b> | New wounds: <b>${newWounds}</b></p>
      <p style="opacity:0.8">Bennies spent: <b>0</b></p>
    </div>
  `;

  await ChatMessage.create({
    user: game.user.id,
    speaker: ChatMessage.getSpeaker({ actor }),
    content
  });
}

async function resolveActorFromContext({ message, button }) {
  // 1) Speaker actor (often present)
  const speakerActor = message?.speaker?.actor ? game.actors?.get(message.speaker.actor) : null;
  if (speakerActor) return speakerActor;

  // 2) Button dataset actor UUID / id (varies by card implementation)
  const uuid =
    button?.dataset?.actorUuid ||
    button?.dataset?.uuid ||
    button?.dataset?.documentUuid;

  if (uuid) {
    const doc = await fromUuid(uuid);
    if (doc?.actor) return doc.actor;
    if (doc?.documentName === "Actor") return doc;
  }

  const actorId =
    button?.dataset?.actorId ||
    button?.dataset?.actor;

  if (actorId) {
    const a = game.actors?.get(actorId);
    if (a) return a;
  }

  // 3) Message flags (some implementations store actor uuid here)
  const flagUuid =
    foundry.utils.getProperty(message, "flags.swade.actorUuid") ||
    foundry.utils.getProperty(message, "flags.swade.actor") ||
    foundry.utils.getProperty(message, "flags.swade.data.actorUuid");

  if (flagUuid) {
    const doc = await fromUuid(flagUuid);
    if (doc?.documentName === "Actor") return doc;
    if (doc?.actor) return doc.actor;
  }

  return null;
}

function resolvePendingWounds({ message, button, actor }) {
  // Common places:
  // - button.dataset.wounds
  // - message.flags.* damage data
  // We keep this flexible; if not found, return NaN.
  const ds = button?.dataset ?? {};
  const direct =
    ds.wounds ??
    ds.pendingWounds ??
    ds.appliedWounds ??
    ds.wound ??
    ds.w;

  const fromDataset = toNumberOrNaN(direct);
  if (Number.isFinite(fromDataset)) return fromDataset;

  const fromFlags =
    toNumberOrNaN(foundry.utils.getProperty(message, "flags.swade.damage.wounds")) ||
    toNumberOrNaN(foundry.utils.getProperty(message, "flags.swade.damageData.wounds")) ||
    toNumberOrNaN(foundry.utils.getProperty(message, "flags.swade.wounds")) ||
    NaN;

  if (Number.isFinite(fromFlags)) return fromFlags;

  // As a final fallback, if the button has a tooltip that includes wounds, try to parse it
  const title = (button?.title || "").toLowerCase();
  const m = title.match(/(\d+)\s*wound/);
  if (m) return Number(m[1]);

  return NaN;
}

function toNumberOrNaN(v) {
  if (v === undefined || v === null || v === "") return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

async function promptForAttribute(actor) {
  const attrs = ["agility", "smarts", "spirit", "strength", "vigor"];
  const options = attrs.map(a => `<option value="${a}">${attributeLabel(a)}</option>`).join("");

  const content = `
    <form>
      <div class="form-group">
        <label>Choose Attribute for Soak</label>
        <select name="attr">${options}</select>
        <p class="notes">House rule: Soak costs 0 Bennies and may use any Attribute.</p>
      </div>
    </form>
  `;

  return await new Promise((resolve) => {
    new Dialog({
      title: `Soak (House Rule): ${actor.name}`,
      content,
      buttons: {
        ok: {
          label: "Roll Soak",
          callback: (html) => {
            const val = html.find("select[name='attr']").val();
            resolve(String(val));
          }
        },
        cancel: {
          label: "Cancel",
          callback: () => resolve(null)
        }
      },
      default: "ok"
    }).render(true);
  });
}

function attributeLabel(key) {
  const map = {
    agility: "Agility",
    smarts: "Smarts",
    spirit: "Spirit",
    strength: "Strength",
    vigor: "Vigor"
  };
  return map[key] ?? key;
}

async function rollAttribute(actor, attrKey) {
  // Prefer SWADE’s method if present
  // Common possibilities: actor.rollAttribute, actor.rollTrait, actor.roll
  if (typeof actor.rollAttribute === "function") {
    return await actor.rollAttribute(attrKey);
  }

  // Fallback: build a basic roll from the attribute die (best effort)
  const sides = foundry.utils.getProperty(actor, `system.attributes.${attrKey}.die.sides`);
  const wildSides = foundry.utils.getProperty(actor, `system.wildDie.sides`) ?? 6;

  if (!sides) throw new Error(`Actor missing attribute die data for: ${attrKey}`);

  // SWADE roll is Trait die + Wild die, take highest, with acing.
  // We’ll approximate using two acing rolls and take highest total.
  const r1 = await (new Roll(`1d${sides}x`)).evaluate();
  const r2 = await (new Roll(`1d${wildSides}x`)).evaluate();
  const total = Math.max(r1.total, r2.total);

  // Display the roll(s)
  await r1.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: `Soak (House Rule) - ${attributeLabel(attrKey)} Trait Die` });
  await r2.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: `Soak (House Rule) - Wild Die` });

  return { total };
}

function computeSoakFromTotal(total) {
  if (!Number.isFinite(total) || total < 4) return 0;
  const raises = Math.floor((total - 4) / 4);
  return 1 + raises;
}
