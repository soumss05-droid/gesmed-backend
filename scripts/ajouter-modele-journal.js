// Ajoute le modèle JournalEquipe à la FIN de prisma/schema.prisma.
//
// - Ne modifie rien d'existant : le texte est seulement AJOUTÉ à la fin.
// - Fait d'abord une copie de sauvegarde : prisma/schema.prisma.sauvegarde-journal
// - Écrit en UTF-8 (les accents du fichier restent intacts).
// - Si le modèle est déjà présent, il ne fait rien (peut être relancé sans risque).
// - Usage (dans le dossier gesmed-backend) :  node scripts/ajouter-modele-journal.js
const fs = require("fs");
const path = require("path");

const chemin = path.join(__dirname, "..", "prisma", "schema.prisma");
const sauvegarde = chemin + ".sauvegarde-journal";

const MODELE = `
// ============================================================
// Journal des créations faites par les GAS DRS (écran « Mon équipe » et
// import en masse). Lecture par l'administrateur uniquement. Volontairement
// SANS relation avec les autres tables : les noms sont copiés au moment de
// l'action, pour rester lisibles même si un compte change ensuite.
// ============================================================
model JournalEquipe {
  id               String   @id @default(uuid())
  auteurId         String   @map("auteur_id")
  auteurNom        String   @map("auteur_nom")
  drsId            String   @map("drs_id")
  drsNom           String   @map("drs_nom")
  action           String
  role             String?
  etablissementNom String   @map("etablissement_nom")
  compteNom        String   @map("compte_nom")
  identifiant      String
  lu               Boolean  @default(false)
  createdAt        DateTime @default(now()) @map("created_at")

  @@map("journal_equipe")
}
`;

if (!fs.existsSync(chemin)) {
  console.error("Fichier introuvable : " + chemin + "\nLance la commande depuis le dossier gesmed-backend.");
  process.exit(1);
}

const contenu = fs.readFileSync(chemin, "utf8");

if (/model\s+JournalEquipe\s*\{/.test(contenu)) {
  console.log("Le modèle JournalEquipe est déjà dans schema.prisma : rien à faire.");
  process.exit(0);
}

if (!fs.existsSync(sauvegarde)) fs.copyFileSync(chemin, sauvegarde); // jamais écrasée
const separateur = contenu.endsWith("\n") ? "" : "\n";
fs.appendFileSync(chemin, separateur + MODELE, "utf8");

console.log("Modèle JournalEquipe ajouté à la fin de prisma/schema.prisma.");
console.log("Sauvegarde de l'ancien fichier : prisma/schema.prisma.sauvegarde-journal");