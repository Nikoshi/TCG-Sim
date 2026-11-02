/* RESTNETZ · Anzeige und Bedienung, Regeln bleiben ausschließlich in Rust/WASM. */
import init, { WasmGame, playtest_gate_enabled, playtest_expires_at_ms, unlock_playtest } from "./pkg/restnetz_simulator.js";
import {
  actionType, actionPayload, forSelection, forTarget, noTarget, phaseMessage,
  noActionExplanation,
} from "./interaction.mjs";

const $ = (id) => document.getElementById(id);
const NODES = [
  ["Power", "01", "Umspannwerk", "+1 Energie", "power"],
  ["Data", "02", "Datenknoten", "1 ziehen / 1 abwerfen", "data"],
  ["Repair", "03", "Reparaturhof", "1 Schaden entfernen", "repair"],
];
const PHASES = {
  Supply: "Versorgung", Control: "Kontrolle",
  Deploy: "Einsatz", Actions: "Aktionen", Finished: "Partie beendet",
};
const PEOPLE = ["Kollektive", "Transitverbände"];
const ERROR_TEXT = {
  WrongPhase: "Diese Aktion gehört nicht zur aktuellen Zugphase.",
  InvalidCard: "Diese Handkarte kann so nicht eingesetzt werden.",
  InvalidTarget: "Dieses Ziel ist für die Aktion nicht zulässig.",
  InsufficientEnergy: "Für diesen Spielzug fehlt Energie.",
  NodeFull: "An diesem Knoten stehen bereits zwei deiner Einheiten.",
  AlreadyUsed: "Diese einmalige Aktion wurde im aktuellen Zug bereits genutzt.",
  PendingBonus: "Zuerst muss der offene Knotenbonus abgeschlossen werden.",
  EffectTargetUndecided: "Ein gültiges Ziel fehlt. Wähle eine beschädigte eigene Einheit.",
  NoCardsToDraw: "Der Nachziehstapel ist leer. Dieser Zieheffekt ist nicht spielbar.",
  PendingDiscard: "Erst die gezogene Karte ansehen und eine Handkarte auf die Ablage legen.",
};
let game;
let state;
let choices = [];
let catalog = {};
let selected = null;        // {kind:"card",index} oder {kind:"unit",id}
let pending = null;         // eine vom Rust-Kern ausdrücklich angebotene Aktion
let candidates = [];       // gültige Aktionen für das angeklickte Ziel
let selectedGroup = "";    // Filter der optionalen Entwicklersteuerung
let drawFeedback = "";     // Ergebnis der bewusst ausgelösten Versorgung
let motionCue = null;      // Nur nach echter Rust-Aktion, nicht bei jeder Auswahl
let previousPhase = null;
let returnToPreviousAction = null; // Vorherige Auswahl bei Abbruch einer Verwertung
let handLayoutKey = null;
let largestHandHeight = 0; // Handfläche während des aktuellen Zuges nicht zusammenziehen
let actionLayoutKey = null;
let largestActionHeight = 0; // Auch bei wechselnden Alternativen keine Sprünge

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}
function clear(node) { node.replaceChildren(); }
function cardName(id) { return catalog[id]?.name ?? id; }
function sameChoice(a, b) {
  return !!a && !!b && JSON.stringify(a.action) === JSON.stringify(b.action);
}
function discardSource() {
  return state?.pending_discard === "Data" ? "Datenknoten" : "Aufklärerin";
}
function renderDiscardPile() {
  const discarded = state.players[state.active].discard;
  $("discard-count").textContent = discarded.length +
    (discarded.length === 1 ? " Karte" : " Karten");
  const isDiscarding = state.pending_discard != null;
  const converting = pending && actionType(pending.action) === "Convert";
  const convert = !isDiscarding && selected?.kind === "card"
    ? actionList().find(choice => actionType(choice.action) === "Convert")
    : null;
  const button = $("discard-convert");
  button.hidden = !convert || !!converting;
  const card = convert ? state.players[state.active].hand[selected.index] : null;
  if (card) {
    button.textContent = "ABLEGEN · +1 EN →";
    button.setAttribute("aria-label", "„" + cardName(card) + "“ ablegen und +1 temporäre Energie erhalten");
  }
  // Stapel und Karten bleiben unverrückt. Der Button liegt bei Bedarf
  // über derselben Stapelfläche und öffnet einen nativen Dialog.
  const zone = $("discard-zone");
  zone.classList.toggle("can-convert", !!convert && !converting);
  zone.classList.toggle("awaiting-discard", isDiscarding || !!converting);
  $("discard-last").textContent = isDiscarding
    ? "Wähle eine Handkarte zum Abwerfen"
    : converting ? "Ablagebestätigung geöffnet"
      : card ? "Gewählt: „" + cardName(card) + "“"
        : discarded.length ? "Zuletzt: " + cardName(discarded.at(-1))
          : "Noch keine Karten abgelegt.";
}

function showDiscardDialog(choice) {
  const type = actionType(choice.action);
  if (!["DiscardPending", "Convert"].includes(type)) return;
  const index = actionPayload(choice.action).hand_index;
  const card = state.players[state.active].hand[index];
  if (!card) return;
  const converting = type === "Convert";
  $("discard-dialog-card").textContent = cardName(card);
  $("discard-dialog-title").textContent = converting
    ? "Karte für Energie ablegen?" : "Handkarte abwerfen?";
  $("discard-dialog-description").textContent = converting
    ? "Diese Karte landet auf deinem Ablagestapel. Dafür erhältst du +1 temporäre Energie (einmal pro Zug)."
    : discardSource() + ": Du musst eine Handkarte abwerfen. Dafür erhältst du keine Energie.";
  $("discard-dialog-confirm").textContent = converting
    ? "Ablegen · +1 Energie →" : "Karte abwerfen →";
  $("discard-dialog-error").hidden = true;
  const dialog = $("discard-dialog");
  if (!dialog.open) dialog.showModal();
  $("discard-dialog-confirm").focus({ preventScroll: true });
}

function closeDiscardDialog() {
  const dialog = $("discard-dialog");
  if (dialog.open) dialog.close();
  pending = returnToPreviousAction;
  returnToPreviousAction = null;
  candidates = [];
  render();
  // Ein verworfener Dialog verändert weder Spielzustand noch Handkarte.
  if (state.pending_discard) {
    $("hand").querySelector(".hand-card.discard-required")?.focus({ preventScroll: true });
  } else if (selected?.kind === "card") {
    $("hand").querySelectorAll(".hand-card")[selected.index]?.focus({ preventScroll: true });
  }
}

// Nach bestätigtem Abwurf nicht auf den inzwischen versteckten Auslöser
// zurückfallen. Die nächste sichtbare Aktion erhält den Tastaturfokus.
function focusAfterDiscard() {
  const available = [
    $("phase-next"),
    $("confirm-choice"),
    $("draw-deck"),
    $("hand").querySelector(".hand-card:not(:disabled)"),
  ];
  const next = available.find(node => node && !node.hidden && !node.disabled);
  next?.focus({ preventScroll: true });
}

function showActionDialog(choice) {
  if (!choice || ["DiscardPending", "Convert"].includes(actionType(choice.action))) return;
  $("action-dialog-description").textContent = choice.label;
  const type = actionType(choice.action);
  const detail = type === "PlayScout"
    ? "Beim Ausspielen: Karte ziehen und danach eine Handkarte abwerfen."
    : type === "DataBonus"
      ? "Ziehe eine Karte; danach wählst du die tatsächlich abzuwerfende Handkarte."
      : "";
  $("action-dialog-detail").textContent = detail;
  $("action-dialog-detail").hidden = !detail;
  $("action-dialog-error").hidden = true;
  const dialog = $("action-dialog");
  if (!dialog.open) dialog.showModal();
  $("action-dialog-confirm").focus({ preventScroll: true });
}
function closeActionDialog() {
  $("action-dialog").close();
  pending = null;
  candidates = [];
  render();
  const restore = selected?.kind === "card"
    ? $("hand").querySelectorAll(".hand-card")[selected.index]
    : selected?.kind === "unit"
      ? $("nodes").querySelector(".unit.selected") : null;
  (restore || $("phase-next")).focus({ preventScroll: true });
}
function focusAfterAction() {
  const next = $("handoff").hidden
    ? [$("phase-next"), $("draw-deck"), $("hand").querySelector(".hand-card:not(:disabled)"), $("nodes").querySelector("button.unit")]
    : [$("handoff-confirm")];
  next.find(node => node && !node.hidden && !node.disabled)?.focus({ preventScroll: true });
}

function animateCardToDiscard(cardRect, label) {
  // Reines Feedback. Der Spielzustand wurde bereits durch Rust geändert.
  if (!cardRect || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const target = $("discard-zone").getBoundingClientRect();
  const ghost = element("div", "transfer-ghost", label);
  ghost.setAttribute("aria-hidden", "true");
  ghost.style.left = cardRect.left + "px";
  ghost.style.top = cardRect.top + "px";
  ghost.style.width = Math.min(cardRect.width, 175) + "px";
  document.body.append(ghost);
  const dx = target.left + target.width / 2 - (cardRect.left + cardRect.width / 2);
  const dy = target.top + target.height / 2 - cardRect.top;
  if (typeof ghost.animate !== "function") {
    ghost.remove();
    return;
  }
  const animation = ghost.animate([
    { opacity: .85, transform: "translate(0, 0) scale(1)" },
    { opacity: 0, transform: "translate(" + dx + "px," + dy + "px) scale(.65)" },
  ], { duration: 310, easing: "ease-in", fill: "forwards" });
  animation.onfinish = () => ghost.remove();
  animation.oncancel = () => ghost.remove();
}

function stat(label, value) {
  const span = element("span");
  span.append(element("b", "", value), document.createTextNode(" " + label));
  return span;
}
function infoFor(id) {
  const card = catalog[id] || {};
  const stats = card.attack == null ? "OPERATION" : card.attack + " ATK · " + card.health + " LP";
  return (card.cost ?? "?") + " EN · " + stats;
}
function actionList() {
  return selected ? forSelection(choices, selected) : state?.phase === "Control" ? choices : [];
}
function chooseSelection(selection) {
  selected = selection;
  pending = null;
  candidates = [];
  render();
}
function openTarget(target) {
  const matched = forTarget(actionList(), target);
  if (!matched.length) return;
  candidates = matched;
  pending = matched.length === 1 ? matched[0] : null;
  render();
  if (pending) showActionDialog(pending);
}
function offerChoice(choice) {
  const discard = ["DiscardPending", "Convert"].includes(actionType(choice.action));
  if (discard) returnToPreviousAction = pending;
  pending = choice;
  candidates = [];
  render();
  if (discard) showDiscardDialog(choice);
  else showActionDialog(choice);
}

function clearSelection() {
  selected = null;
  pending = null;
  candidates = [];
  render();
}
function addActionButton(parent, text, handler, className = "choice-button") {
  const button = element("button", className, text);
  button.type = "button";
  button.addEventListener("click", handler);
  parent.append(button);
  return button;
}
function isAvailable(target) {
  return forTarget(actionList(), target).length > 0;
}

function noActionMessage() {
  if (selected || pending || state.pending_discard || candidates.length) return null;
  return noActionExplanation(state.phase, choices);
}

function renderTurnGuide() {
  const steps = {
    Supply: ["01 / VERSORGUNG", "Klicke auf den Nachziehstapel. Du erhältst Energie und ziehst eine Karte."],
    Control: ["02 / KONTROLLE", "Prüfe die kontrollierten Knoten und entscheide über offene Boni."],
    Deploy: ["03 / EINSATZ", "Wähle eine Handkarte aus. Danach werden ihre möglichen Ziele markiert."],
    Actions: ["04 / AKTIONEN", "Wähle eine eigene Einheit zum Angreifen oder Verlegen. Danach den Zug beenden."],
    Finished: ["05 / ERGEBNIS", "Die Partie ist beendet. Du kannst eine neue Testpartie starten."],
  };
  let [heading, instruction] = steps[state.phase] || ["SPIELSTAND", "Nächsten Schritt prüfen."];
  if (state.pending_discard) {
    heading = state.pending_discard === "Data" ? "02 / DATENKNOTEN" : "03 / AUFKLÄRERIN";
    instruction = discardSource() +
      ": Karte gezogen. Abwerfen: Wähle eine Handkarte und bestätige, dass sie auf den Ablagestapel gelegt wird.";
  } else if (state.phase === "Deploy" && selected?.kind === "card" &&
      forSelection(choices, selected).some(choice => actionType(choice.action) === "Convert")) {
    instruction = "Wähle ein gültiges Ziel oder lege die ausgewählte Karte " +
      "am Ablagestapel für +1 Energie ab.";
  }
  $("step-index").textContent = heading;
  $("turn-instruction").textContent = noActionMessage() || instruction;
  $("draw-feedback").textContent = drawFeedback;
  const remaining = state.players[state.active].deck.length;
  $("deck-remaining").textContent = "Nachziehstapel · " + remaining + (remaining === 1 ? " Karte" : " Karten");
  const supply = choices.find(choice => actionType(choice.action) === "Supply");
  const pile = $("draw-deck");
  pile.disabled = !supply;
  pile.classList.toggle("ready", !!supply);
  $("draw-button-label").textContent = supply
    ? (remaining ? "Karte ziehen + Energie erhalten" : "Versorgung ohne Ziehen")
    : "Nachziehstapel";
  pile.setAttribute("aria-label", supply
    ? (remaining ? "Versorgung durchführen und eine Karte ziehen" : "Versorgung ohne Kartenziehen durchführen")
    : "Nachziehstapel, im Moment keine Ziehaktion verfügbar");
}

function renderPlayers() {
  const root = $("players");
  clear(root);
  state.players.forEach((person, index) => {
    const pane = element("article", "player" + (index === state.active ? " active" : ""));
    pane.append(element("div", "player-name", PEOPLE[index]));
    const stats = element("div", "player-values");
    stats.append(
      stat("LP", person.hp), stat("NP", person.points), stat("EN", person.energy),
      stat("MAX", person.max_energy),
    );
    pane.append(stats, element("div", "stats",
      "Hand " + person.hand.length + " · Deck " + person.deck.length +
      " · Ablage " + person.discard.length));
    const target = { kind: "base", id: "opponent" };
    if (index !== state.active && isAvailable(target)) {
      addActionButton(pane, "Diese Basis angreifen →",
        () => openTarget(target), "target-button base-target");
      pane.classList.add("can-target");
    }
    root.append(pane);
  });
}

function renderNodes() {
  const root = $("nodes");
  clear(root);
  NODES.forEach(([nodeKey, index, name, bonus, className], idx) => {
    const node = element("section", "node " + className);
    const heading = element("div", "node-header");
    heading.append(element("span", "node-index", index));
    heading.append(element("h3", "", name), element("p", "", bonus));
    node.append(heading);

    const nodeTarget = { kind: "node", id: nodeKey };
    if (isAvailable(nodeTarget)) {
      node.classList.add("can-target");
      addActionButton(node,
        selected?.kind === "unit" ? "Hierhin verlegen →" : "Hier einsetzen →",
        () => openTarget(nodeTarget), "target-button node-target");
    }

    const units = element("div", "node-units");
    const placed = state.board[idx];
    if (!placed.length) units.append(element("span", "empty", "NICHT BESETZT"));

    for (const entry of placed) {
      const owner = entry.unit.owner;
      const id = entry.id;
      const unitSelection = { kind: "unit", id };
      const unitTarget = { kind: "unit", id };
      const selectedThis = selected?.kind === "unit" && selected.id === id;
      const canSelect = state.phase === "Actions" && owner === state.active + 1
        && forSelection(choices, unitSelection).length > 0;
      const canTarget = isAvailable(unitTarget);
      const card = element(canSelect || canTarget ? "button" : "div",
        "unit owner-" + owner + (selectedThis ? " selected" : "") +
        (canTarget ? " can-target" : "") +
        (motionCue?.newUnitId === entry.id ? " appeared" : ""));
      if (canSelect || canTarget) {
        card.type = "button";
        card.setAttribute("aria-pressed", String(selectedThis));
        card.addEventListener("click", () => {
          if (canTarget && !selectedThis) openTarget(unitTarget);
          else if (canSelect) chooseSelection(selectedThis ? null : unitSelection);
        });
      }
      card.append(element("span", "owner", PEOPLE[owner - 1].toUpperCase() + " / #" + id));
      card.append(element("strong", "unit-name", cardName(entry.card)));
      if (catalog[entry.card]?.effect) {
        card.title = catalog[entry.card].effect;
        card.append(element("span", "unit-ability", "◆ SONDERAKTION"));
      }
      card.append(element("span", "stats", "ATK " + entry.unit.attack +
        " · LP " + (entry.unit.health - entry.unit.damage) + "/" + entry.unit.health));
      if (entry.unit.just_played) card.append(element("span", "marker", "NEU"));
      else if (entry.unit.moved) card.append(element("span", "marker", "VERLEGT"));
      else if (entry.unit.attacked) card.append(element("span", "marker", "AKTION VERBRAUCHT"));
      if (canSelect || canTarget) card.append(element("span", "tap-label",
        canTarget ? "ZIEL WÄHLEN ↗" : "EINHEIT WÄHLEN ↗"));
      units.append(card);
    }
    node.append(units);
    root.append(node);
  });
}

function renderHand() {
  const hand = state.players[state.active].hand;
  $("hand-count").textContent = hand.length + " KARTEN";
  const root = $("hand");
  clear(root);
  hand.forEach((id, index) => {
    const needsDiscard = state.pending_discard != null;
    const discardChoice = needsDiscard
      ? choices.find(choice =>
        actionType(choice.action) === "DiscardPending" &&
        actionPayload(choice.action).hand_index === index)
      : null;
    const chosen = needsDiscard
      ? sameChoice(pending, discardChoice)
      : selected?.kind === "card" && selected.index === index;
    const options = needsDiscard ? [] : forSelection(choices, { kind: "card", index });
    const pane = element("button",
      "hand-card" + (id.startsWith("T") ? " transit" : "") +
      (chosen ? " selected" : "") +
      (needsDiscard ? " discard-required" : !options.length ? " unavailable" : "") +
      (motionCue?.drawIndex === index ? " drawn-in" : ""));
    pane.type = "button";
    pane.setAttribute("aria-pressed", String(chosen));
    pane.append(element("span", "hand-id", "HAND " + (index + 1) + " / " + id));
    pane.append(element("strong", "hand-name", cardName(id)));
    pane.append(element("span", "hand-kind", catalog[id]?.attack == null ? "OPERATION" : "EINHEIT"));
    pane.append(element("span", "hand-stats", infoFor(id)));
    if (catalog[id]?.effect) {
      // Kurzer Kartentext bleibt sichtbar; Hover/Fokus zeigt den vollständigen
      // Text als Überlagerung, ohne ein zweites Dokumentfeld zu öffnen.
      pane.dataset.effect = catalog[id].effect;
      pane.append(element("span", "ability-flag", "◆ SONDERAKTION"));
      pane.append(element("span", "ability-line", catalog[id].effect));
    }
    const notReady = state.phase !== "Deploy";
    if (needsDiscard) pane.append(element("span", "tap-label", chosen ? "ZUM ABWERFEN GEWÄHLT" : "DIESE KARTE ABWERFEN ↗"));
    else if (notReady) pane.append(element("span", "tap-label", "NACH DER VERSORGUNG"));
    else if (!options.length) pane.append(element("span", "tap-label", "JETZT NICHT SPIELBAR"));
    else pane.append(element("span", "tap-label", chosen ? "AUSGEWÄHLT" : "AUSWÄHLEN ↗"));
    pane.disabled = notReady || (needsDiscard && !discardChoice);
    if (needsDiscard && discardChoice) {
      pane.addEventListener("click", () => offerChoice(discardChoice));
    } else if (!notReady) {
      pane.addEventListener("click", () => chooseSelection(chosen ? null : { kind: "card", index }));
    }
    root.append(pane);
  });
  if (!hand.length) root.append(element("div", "empty", "KEINE HANDKARTEN"));
  // Beim Ausspielen der sechsten Karte darf das Spielfeld nicht hochspringen.
  const layoutKey = state.turn + ":" + state.active;
  if (handLayoutKey !== layoutKey) { handLayoutKey = layoutKey; largestHandHeight = 0; }
  root.style.minHeight = "0px";
  largestHandHeight = Math.max(largestHandHeight, root.scrollHeight);
  root.style.minHeight = largestHandHeight + "px";
  renderDiscardPile();
}

function renderCommands() {
  const guide = $("guide");
  const emptyMessage = noActionMessage();
  // Die allgemeine Anleitung steht bereits über dem Feld. Das Bedienpult
  // erklärt nur konkrete Auswahl oder die wirklich fehlende Aktion.
  guide.hidden = state.pending_discard != null || !!pending ||
    (!selected && !candidates.length);
  guide.classList.toggle("no-actions", !!emptyMessage);
  const phaseAction = choices.find(c => ["ToActions", "EndTurn"].includes(actionType(c.action)));
  $("phase-next").hidden = !phaseAction || !!pending || state.pending_discard != null;
  if (phaseAction) {
    $("phase-next").textContent =
      actionType(phaseAction.action) === "ToActions" ? "AKTIONSPHASE BEGINNEN →" : "ZUG BEENDEN →";
    $("phase-next").onclick = () => executeChoice(phaseAction);
  }

  const selectionBox = $("selection");
  selectionBox.hidden = !selected || !!pending;
  if (selected) {
    const title = selected.kind === "card"
      ? cardName(state.players[state.active].hand[selected.index])
      : "#" + selected.id + " · " +
        cardName(state.board.flat().find(u => u.id === selected.id)?.card);
    $("selection-title").textContent = "AUSGEWÄHLT / " + title;
  }
  guide.textContent = emptyMessage || (state.pending_discard
    ? discardSource() + ": Wähle die Karte unten und bestätige am eingeblendeten Ablagestapel."
    : pending
      ? "Jetzt ausführen: " + pending.label + "?"
      : candidates.length > 1
        ? "Mehrere Effekte möglich. Wähle eine Variante."
        : phaseMessage(state.phase, !!selected));
  if (selected && actionList().length === 0) {
    guide.textContent = "Für diese Auswahl gibt es gerade keine gültige Aktion. Andere Karte oder Einheit wählen.";
  }

  const root = $("direct-choices");
  clear(root);
  if (state.pending_discard) {
    // Der Ablagestapel erscheint direkt über den Handkarten.
    // Kein zweites Menü und kein doppelter Button im Bedienpult.
  } else if (candidates.length > 1) {
    const head = element("p", "direct-label", "WÄHLE DIE GEWÜNSCHTE VARIANTE");
    root.append(head);
    for (const choice of candidates) {
      const button = addActionButton(root, choice.label, () => offerChoice(choice));
      if (sameChoice(choice, pending)) button.classList.add("selected");
    }
  } else if (state.phase === "Control" && !selected) {
    root.append(element("p", "direct-label", "OFFENE KNOTENENTSCHEIDUNG"));
    // Auswahlliste und anklickbare Ziel-Einheiten zeigen dieselben Rust-Optionen.
    for (const choice of choices) {
      const button = addActionButton(root, choice.label, () => offerChoice(choice));
      if (sameChoice(choice, pending)) button.classList.add("selected");
    }
  } else if (selected) {
    const direct = noTarget(actionList());
    // Ein direkter Alternativweg reicht. Die bereits gewählte Aktion
    // steht ausschließlich im Bestätigungsbereich, niemals doppelt.
    const other = direct.filter(choice =>
      !sameChoice(choice, pending) && actionType(choice.action) !== "Convert");
    if (other.length) root.append(element("p", "direct-label", "ALTERNATIVE"));
    for (const choice of other) {
      const type = actionType(choice.action);
      const label = type === "Convert" ? "Karte für +1 Energie verwerten" : choice.label;
      const button = addActionButton(root, label, () => offerChoice(choice), "choice-button secondary-choice");
      if (sameChoice(choice, pending)) button.classList.add("selected");
    }
  }
  // Karteneffekte und Aktionsbeschreibung stehen im Popup, nicht zusätzlich
  // in einem wachsenden Infokasten hinter dem Popup.
  $("action-explain").hidden = true;
  // Nur der modale Dialog darf eine Ausführung bestätigen.
  $("confirm-choice").hidden = true;
  $("cancel-pending").hidden = true;
}

function renderAdvanced() {
  const groups = [...new Set(choices.map(choice => choice.group))];
  if (!groups.includes(selectedGroup)) selectedGroup = groups[0] || "";
  const root = $("group-select");
  clear(root);
  for (const group of groups) {
    const button = addActionButton(root, group, () => {
      selectedGroup = group;
      renderAdvanced();
    }, "group-button" + (group === selectedGroup ? " active" : ""));
    button.setAttribute("aria-pressed", String(group === selectedGroup));
  }
  const choiceSelect = $("action-select");
  clear(choiceSelect);
  choices.forEach((choice, index) => {
    if (choice.group !== selectedGroup) return;
    const option = element("option", "", choice.label);
    option.value = String(index);
    choiceSelect.append(option);
  });
  $("execute").disabled = !choiceSelect.options.length;
  $("selection-note").textContent = choiceSelect.options.length +
    " von Rust erlaubte Aktionen in dieser Gruppe";
}

function render() {
  const view = JSON.parse(game.snapshot());
  ({ state, choices } = view);
  catalog = Object.fromEntries(view.card_catalog.map(card => [card.id, card]));
  $("boot").hidden = true;
  $("handoff").hidden = true;
  $("game").hidden = false;
  $("active-name").textContent = PEOPLE[state.active];
  $("turn-strip").dataset.faction = String(state.active);
  $("game").dataset.faction = String(state.active);
  $("turn-number").textContent = String(state.turn);
  $("phase-name").textContent = PHASES[state.phase] || state.phase;
  if (previousPhase !== null && previousPhase !== state.phase) {
    $("phase-name").classList.remove("phase-updated");
    void $("phase-name").offsetWidth;
    $("phase-name").classList.add("phase-updated");
  } else {
    $("phase-name").classList.remove("phase-updated");
  }
  previousPhase = state.phase;
  renderTurnGuide();
  renderPlayers();
  renderNodes();
  renderHand();
  renderCommands();
  // Solange der Zug läuft, bleibt die höchste benötigte Kontextleistenhöhe
  // erhalten. Sonst schrumpft der Bereich bei Popup/Verwertung oder Phasenwechsel.
  const actionKey = state.turn + ":" + state.active;
  if (actionLayoutKey !== actionKey) {
    actionLayoutKey = actionKey;
    largestActionHeight = 0;
  }
  const actionBar = document.querySelector(".turn-action");
  actionBar.style.minHeight = "";
  largestActionHeight = Math.max(largestActionHeight, Math.ceil(actionBar.getBoundingClientRect().height));
  actionBar.style.minHeight = largestActionHeight + "px";
  renderAdvanced();
  const won = state.winner !== null;
  $("winner").hidden = !won;
  if (won) $("winner").textContent = PEOPLE[state.winner] + " gewinnt die Partie.";
  $("latest-event").textContent = state.log.at(-1) || "Testpartie eingerichtet.";
  const log = $("events");
  clear(log);
  for (const message of state.log.slice(-8, -1).reverse()) {
    log.append(element("li", "", message));
  }
  $("events").closest("details").hidden = !log.childElementCount;
  motionCue = null;
}

function advanceCertainPhases() {
  if (enforcePlaytestExpiry()) return;
  // Bewusstes Nachziehen bleibt immer eine explizite Aktion am Stapel.
  // Nur die anschließende Knotenfeststellung ohne Entscheidungen erfolgt automatisch.
  for (let count = 0; count < 4; count++) {
    const view = JSON.parse(game.snapshot());
    const type = view.state.phase === "Control" && !view.state.pending_bonuses.length
      ? "EvaluateControl" : null;
    if (!type) break;
    const choice = view.choices.find(item => actionType(item.action) === type);
    if (!choice) break;
    const result = JSON.parse(game.apply(JSON.stringify(choice.action)));
    if (!result.ok) throw new Error(result.error);
  }
}

function executeChoice(choice) {
  if (enforcePlaytestExpiry() || !choice) return false;
  const prior = state.active;
  const drawnBefore = state.players[prior].deck.length;
  const type = actionType(choice.action);
  const isSupply = type === "Supply";
  const discarded = ["DiscardPending", "Convert"].includes(type)
    ? state.players[prior].hand[actionPayload(choice.action).hand_index] : null;
  const departingElement = discarded
    ? $("hand").querySelectorAll(".hand-card")[actionPayload(choice.action).hand_index]
    : null;
  const departingRect = departingElement?.getBoundingClientRect() ?? null;
  const beforeDiscardCount = state.players[prior].discard.length;
  const previousUnitIds = new Set(state.board.flat().map(unit => unit.id));
  const discardReason = state.pending_discard === "Data" ? "Datenknoten" : "Aufklärerin";
  try {
    const result = JSON.parse(game.apply(JSON.stringify(choice.action)));
    if (!result.ok) {
      $("error").textContent = ERROR_TEXT[result.error] || "Nicht erlaubt: " + result.error;
      return false;
    }
    selected = null;
    pending = null;
    candidates = [];
    $("error").textContent = "";
    const nextState = JSON.parse(game.snapshot()).state;
    const drawn = nextState.players[prior].deck.length < drawnBefore;
    const introduced = nextState.board.flat().find(unit => !previousUnitIds.has(unit.id));
    motionCue = {
      drawIndex: drawn ? nextState.players[prior].hand.length - 1 : null,
      newUnitId: introduced?.id ?? null,
    };
    if (isSupply) {
      const card = nextState.players[prior].hand.at(-1);
      drawFeedback = drawnBefore && card
        ? "Gezogen: " + cardName(card) + " · Energie aufgefüllt."
        : "Nachziehstapel leer: keine Karte gezogen · Energie aufgefüllt.";
    } else if (type === "PlayScout" || type === "DataBonus") {
      const source = type === "PlayScout" ? "Aufklärerin" : "Datenknoten";
      const card = nextState.players[prior].hand.at(-1);
      drawFeedback = nextState.pending_discard && card
        ? source + " zieht: " + cardName(card) + ". Wähle jetzt eine Karte für die Ablage."
        : source + ": Stapel leer, kein Ziehen oder Abwerfen.";
    } else if (discarded) {
      drawFeedback = type === "Convert"
        ? "Verwertet: " + cardName(discarded) + " → Ablagestapel. +1 temporäre Energie."
        : discardReason + ": " + cardName(discarded) + " → Ablagestapel.";
    }
    if (nextState.active !== prior) {
      drawFeedback = "";
      // Alte und neue Hände ausblenden, bevor die nächste Person den Bildschirm sieht.
      $("game").hidden = true;
      $("handoff-title").textContent = "Rechner übergeben";
      $("handoff-text").textContent = PEOPLE[nextState.active] +
        " ist jetzt am Zug. Gib den Rechner weiter und zeige erst dann die Handkarten an.";
      $("handoff").hidden = false;
      $("handoff-confirm").focus();
    } else {
      advanceCertainPhases();
      render();
      if (nextState.players[prior].discard.length > beforeDiscardCount) {
        const zone = $("discard-zone");
        zone.classList.remove("updated");
        void zone.offsetWidth;
        zone.classList.add("updated");
        animateCardToDiscard(departingRect, cardName(discarded));
      }
    }
    return true;
  } catch (error) {
    $("error").textContent = "Aktion fehlgeschlagen: " + String(error);
    return false;
  }
}

// Ein frischer Code gehört zu einem frischen CI-Build. Ein einmalig im Tab
// gespeicherter Code übersteht den Reload, wird danach aber sofort gelöscht.
const PENDING_PLAYTEST_CODE = "restnetz.playtest.pending-code.v1";
let playtestExpired = false;
let playtestClockTimer = null;

function updatePlaytestCountdown() {
  if (!playtest_gate_enabled()) return;
  const remaining = Math.max(0, playtest_expires_at_ms() - Date.now());
  const seconds = Math.ceil(remaining / 1000);
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  const clock = $("playtest-clock");
  clock.hidden = false;
  clock.textContent = "CODE " + mm + ":" + ss;
  clock.setAttribute("aria-label", "Playtest-Zeit verbleibend: " + mm + " Minuten " + ss + " Sekunden");
  clock.classList.toggle("playtest-clock-low", remaining > 0 && remaining <= 5 * 60 * 1000);
  clock.classList.toggle("playtest-clock-expired", remaining <= 0);
  if (remaining <= 0) lockExpiredPlaytest();
}

function lockExpiredPlaytest() {
  if (playtestExpired) return;
  playtestExpired = true;
  if (playtestClockTimer !== null) {
    clearInterval(playtestClockTimer);
    playtestClockTimer = null;
  }
  // Auch bei noch offenen Bestätigungsfenstern darf kein Spielzug mehr möglich sein.
  for (const id of ["action-dialog", "discard-dialog"]) {
    if ($(id).open) $(id).close();
  }
  $("game").hidden = true;
  $("handoff").hidden = true;
  $("boot").hidden = true;
  const panel = $("playtest-gate");
  panel.hidden = false;
  panel.dataset.expired = "true";
  $("playtest-gate-title").textContent = "Playtest-Zeit abgelaufen";
  $("playtest-description").textContent =
    "Diese Partie ist gesperrt. Starte einen neuen privaten CI-Lauf und stelle das neue Website-Paket bereit. Gib anschließend den frischen Code ein; die Seite lädt dann den neuen WASM-Build.";
  $("playtest-code").value = "";
  $("playtest-code").disabled = false;
  $("playtest-submit").disabled = false;
  $("playtest-submit").textContent = "NEUEN CODE LADEN →";
  $("playtest-error").textContent = "Der alte Code ist ungültig. Ein neuer Code funktioniert erst mit dem zugehörigen aktualisierten Website-Paket.";
  $("playtest-clock").textContent = "CODE 00:00";
  panel.focus({ preventScroll: true });
}

function enforcePlaytestExpiry() {
  if (!playtest_gate_enabled()) return false;
  if (playtestExpired || Date.now() >= playtest_expires_at_ms()) {
    lockExpiredPlaytest();
    return true;
  }
  return false;
}

async function requirePlaytestCode() {
  if (!playtest_gate_enabled()) return;
  const panel = $("playtest-gate");
  const form = $("playtest-form");
  const codeInput = $("playtest-code");
  const error = $("playtest-error");
  $("boot").hidden = true;
  panel.hidden = false;

  await new Promise(resolve => {
    const tryUnlock = code => {
      let ok = false;
      try {
        ok = unlock_playtest(code);
      } catch (exception) {
        error.textContent = "Codeprüfung fehlgeschlagen: " + String(exception);
        return false;
      }
      if (!ok) {
        error.textContent = "Code ungültig oder abgelaufen. Bitte Code und Website-Paket desselben CI-Laufs verwenden.";
        return false;
      }
      error.textContent = "";
      panel.hidden = true;
      $("boot").hidden = false;
      resolve();
      return true;
    };

    form.addEventListener("submit", event => {
      event.preventDefault();
      const code = codeInput.value.trim();
      codeInput.value = "";
      if (enforcePlaytestExpiry()) {
        if (!code) return;
        // Bei Ablauf akzeptiert das alte WASM absichtlich keinen neuen Code.
        // Ein Reload lädt den aktuellen Build; der Code wird nur dafür einmalig
        // im Tab behalten und beim nächsten Seitenstart direkt wieder gelöscht.
        try {
          sessionStorage.setItem(PENDING_PLAYTEST_CODE, code);
          location.reload();
        } catch {
          error.textContent = "Neuen CI-Build bereitstellen, Seite manuell neu laden und den Code erneut eingeben.";
        }
        return;
      }
      if (!tryUnlock(code)) codeInput.focus();
    });

    form.dataset.ready = "true";
    let retryCode = "";
    try {
      retryCode = sessionStorage.getItem(PENDING_PLAYTEST_CODE) || "";
      sessionStorage.removeItem(PENDING_PLAYTEST_CODE);
    } catch { /* Private Browsing kann Session Storage sperren. */ }
    if (retryCode && !enforcePlaytestExpiry() && tryUnlock(retryCode)) return;
    if (!playtestExpired) codeInput.focus({ preventScroll: true });
  });

  if (enforcePlaytestExpiry()) return;
}

function startPlaytestCountdown() {
  if (!playtest_gate_enabled()) return;
  updatePlaytestCountdown();
  if (playtestExpired) return;
  playtestClockTimer = setInterval(updatePlaytestCountdown, 1000);
  // Hintergrund-Tabs können Timer verzögern. Bei Rückkehr sofort nachprüfen.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) updatePlaytestCountdown();
  });
  window.addEventListener("focus", updatePlaytestCountdown);
  window.addEventListener("pageshow", updatePlaytestCountdown);
}

async function boot() {
  try {
    await init();
    startPlaytestCountdown();
    await requirePlaytestCode();
    if (enforcePlaytestExpiry()) return;
    game = new WasmGame();
    $("draw-deck").addEventListener("click", () => {
      executeChoice(choices.find(choice => actionType(choice.action) === "Supply"));
    });
    $("execute").addEventListener("click", () => {
      const index = Number($("action-select").value);
      if (choices[index]) offerChoice(choices[index]);
    });
    $("confirm-choice").addEventListener("click", () => { if (pending) showActionDialog(pending); });
    $("action-dialog-confirm").addEventListener("click", () => {
      const choice = pending;
      if (!choice) return;
      if (executeChoice(choice)) {
        $("action-dialog").close();
        focusAfterAction();
      } else {
        $("action-dialog-error").textContent = $("error").textContent;
        $("action-dialog-error").hidden = false;
      }
    });
    $("action-dialog-cancel").addEventListener("click", closeActionDialog);
    $("action-dialog").addEventListener("cancel", event => {
      event.preventDefault();
      closeActionDialog();
    });
    $("discard-convert").addEventListener("click", () => {
      const convert = actionList().find(choice => actionType(choice.action) === "Convert");
      if (convert) offerChoice(convert);
    });
    $("discard-dialog-confirm").addEventListener("click", () => {
      const choice = pending;
      if (!choice || !["DiscardPending", "Convert"].includes(actionType(choice.action))) return;
      // Dialog erst bei gültigem Rust-Zug schließen; Fehler bleiben lesbar.
      const result = executeChoice(choice);
      if (result === false) {
        $("discard-dialog-error").textContent = $("error").textContent;
        $("discard-dialog-error").hidden = false;
      } else {
        if ($("discard-dialog").open) $("discard-dialog").close();
        returnToPreviousAction = null;
        focusAfterDiscard();
      }
    });
    $("discard-dialog-cancel").addEventListener("click", closeDiscardDialog);
    $("discard-dialog").addEventListener("cancel", event => {
      event.preventDefault();
      closeDiscardDialog();
    });
    $("cancel-pending").addEventListener("click", () => {
      pending = null;
      candidates = [];
      render();
    });
    $("cancel-selection").addEventListener("click", clearSelection);
    $("handoff-confirm").addEventListener("click", () => {
      try {
        advanceCertainPhases();
        render();
      } catch (error) {
        $("handoff-text").textContent = "Der Zug konnte nicht gestartet werden: " + String(error);
      }
    });
    $("reset").addEventListener("click", () => {
      game.reset();
      selected = null;
      pending = null;
      candidates = [];
      selectedGroup = "";
      returnToPreviousAction = null;
      if ($("discard-dialog").open) $("discard-dialog").close();
      if ($("action-dialog").open) $("action-dialog").close();
      handLayoutKey = null;
      largestHandHeight = 0;
      actionLayoutKey = null;
      largestActionHeight = 0;
      drawFeedback = "";
      motionCue = null;
      previousPhase = null;
      $("error").textContent = "";
      advanceCertainPhases();
      render();
    });
    advanceCertainPhases();
    render();
  } catch (error) {
    $("boot").textContent = "WASM-KERN KONNTE NICHT GELADEN WERDEN. " +
      "Die Teststation benötigt lokales HTTP statt file://. " + String(error);
    $("boot").classList.add("error-message");
  }
}
boot();
