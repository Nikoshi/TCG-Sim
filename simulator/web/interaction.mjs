/* RESTNETZ / UI-Zuordnung. Nur die von Rust angebotenen Aktionen anzeigen. */
export function actionType(action) {
  return typeof action === "string" ? action : Object.keys(action)[0];
}
export function actionPayload(action) {
  return typeof action === "string" ? {} : (Object.values(action)[0] || {});
}
export function forSelection(choices, selection) {
  if (!selection) return [];
  return choices.filter(choice => {
    const type = actionType(choice.action);
    const payload = actionPayload(choice.action);
    if (selection.kind === "card") {
      return ["Play", "PlayScout", "PlayRepairCrew", "PlayOperation", "Convert"].includes(type)
        && payload.hand_index === selection.index;
    }
    if (selection.kind === "unit") {
      return ((type === "AttackBase" || type === "AttackUnit")
          && payload.attacker === selection.id)
        || (type === "Move" && payload.unit_id === selection.id);
    }
    return false;
  });
}
export function targets(choice) {
  const type = actionType(choice.action);
  const p = actionPayload(choice.action);
  if (["Play", "PlayScout", "PlayRepairCrew"].includes(type)) return { kind: "node", id: p.node };
  if (type === "Move") return { kind: "node", id: p.to };
  if (type === "AttackBase") return { kind: "base", id: "opponent" };
  if (type === "AttackUnit") return { kind: "unit", id: p.target };
  if (type === "RepairBonus") return p.unit_id == null ? null : { kind: "unit", id: p.unit_id };
  if (type === "PlayOperation" && p.target != null) return { kind: "unit", id: p.target };
  return null;
}
export function matchTarget(choice, target) {
  const possible = targets(choice);
  return possible !== null && possible.kind === target.kind && possible.id === target.id;
}
export function forTarget(choices, target) {
  return choices.filter(choice => matchTarget(choice, target));
}
export function noTarget(choices) {
  return choices.filter(choice => targets(choice) === null);
}
export function isPhaseAction(choice) {
  return ["Supply", "EvaluateControl", "ToActions", "EndTurn"].includes(actionType(choice.action));
}
export function phaseMessage(phase, hasSelection = false) {
  const messages = {
    Supply: "Klicke oben auf den Nachziehstapel: Energie erhalten und 1 Karte ziehen.",
    Control: "Wähle den Knotenbonus oder eine beschädigte eigene Einheit.",
    Deploy: hasSelection ? "Wähle einen hervorgehobenen Einsatzort oder ein gültiges Ziel."
      : "Wähle zuerst eine Handkarte. Danach zeigen wir dir die möglichen Ziele.",
    Actions: hasSelection ? "Wähle eine hervorgehobene gegnerische Einheit, Basis oder einen Knoten."
      : "Wähle eine eigene Einheit. Dann erscheinen Angriffsziele und mögliche Verlegungen.",
    Finished: "Die Partie ist beendet.",
  };
  return messages[phase] || "Der nächste Schritt wird vorbereitet.";
}

/** Erläutert leere Rust-Aktionsangebote, ohne mögliche Phasenwechsel zu übersehen. */
export function noActionExplanation(phase, choices) {
  const types = choices.map(choice => actionType(choice.action));
  if (phase === "Deploy" && types.includes("ToActions")) {
    const playable = types.some(type =>
      ["Play", "PlayScout", "PlayRepairCrew", "PlayOperation"].includes(type));
    if (!playable) {
      return types.includes("Convert")
        ? "Keine Karte einsetzbar. Du kannst eine Karte für Energie verwerten oder die Aktionsphase beginnen."
        : "Keine weitere Kartenaktion möglich. Aktionsphase beginnen.";
    }
  }
  if (phase === "Actions" && types.length === 1 && types[0] === "EndTurn") {
    return "Kein Angriff und keine Verlegung möglich. Du kannst den Zug beenden.";
  }
  return null;
}
