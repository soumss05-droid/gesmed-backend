// Indicateur d'offre de service : crée les tables (AJOUT SEULEMENT).
// - Sauvegarde schema.prisma, y ajoute les nouveaux modèles et les relations.
// - Crée dans la base : 1 type + 3 tables. Aucune donnée existante n'est touchée.
// Peut être relancé sans risque.
try { require("dotenv").config(); } catch (e) { /* dotenv facultatif */ }

const fs = require("fs");
const path = require("path");
const prisma = require("../src/config/prisma");

const NOUVEAUX_MODELES = `
// ============================================================
// Offre de service par programme
// ============================================================

enum DependanceService {
  PRODUITS
  EQUIPEMENT
  PERSONNEL
  AUTRE
}

model ServiceProgramme {
  id           String               @id @default(uuid())
  programmeId  String               @map("programme_id")
  programme    Programme            @relation(fields: [programmeId], references: [id])
  groupe       String?
  nom          String
  code         String               @unique
  ciblePct     Int?                 @map("cible_pct")
  dependance   DependanceService    @default(AUTRE)
  ordre        Int                  @default(0)
  actif        Boolean              @default(true)
  createdAt    DateTime             @default(now()) @map("created_at")

  offres       OffreService[]
  eligibilites EligibiliteService[]

  @@map("services_programme")
}

model OffreService {
  id              String           @id @default(uuid())
  serviceId       String           @map("service_id")
  service         ServiceProgramme @relation(fields: [serviceId], references: [id])
  etablissementId String           @map("etablissement_id")
  etablissement   Etablissement    @relation(fields: [etablissementId], references: [id])
  offert          Boolean
  declareParId    String?          @map("declare_par_id")
  declarePar      Utilisateur?     @relation(fields: [declareParId], references: [id])
  updatedAt       DateTime         @default(now()) @updatedAt @map("updated_at")

  @@unique([serviceId, etablissementId])
  @@map("offres_service")
}

model EligibiliteService {
  id              String           @id @default(uuid())
  serviceId       String           @map("service_id")
  service         ServiceProgramme @relation(fields: [serviceId], references: [id])
  etablissementId String           @map("etablissement_id")
  etablissement   Etablissement    @relation(fields: [etablissementId], references: [id])

  @@unique([serviceId, etablissementId])
  @@map("eligibilites_service")
}
`;

// Lignes de relation à ajouter dans les modèles existants (virtuelles : aucune colonne).
const RELATIONS = [
  { marqueur: '@@map("programmes")', ligne: "servicesProgramme   ServiceProgramme[]" },
  { marqueur: '@@map("etablissements")', ligne: "offresService       OffreService[]\n  eligibilitesService EligibiliteService[]" },
  { marqueur: '@@map("utilisateurs")', ligne: "offresDeclarees     OffreService[]" },
];

const SQL = [
  `DO $$ BEGIN
     CREATE TYPE "DependanceService" AS ENUM ('PRODUITS', 'EQUIPEMENT', 'PERSONNEL', 'AUTRE');
   EXCEPTION WHEN duplicate_object THEN NULL;
   END $$`,

  `CREATE TABLE IF NOT EXISTS services_programme (
     id TEXT PRIMARY KEY,
     programme_id TEXT NOT NULL REFERENCES programmes(id),
     groupe TEXT,
     nom TEXT NOT NULL,
     code TEXT NOT NULL UNIQUE,
     cible_pct INTEGER,
     dependance "DependanceService" NOT NULL DEFAULT 'AUTRE',
     ordre INTEGER NOT NULL DEFAULT 0,
     actif BOOLEAN NOT NULL DEFAULT true,
     created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
   )`,

  `CREATE TABLE IF NOT EXISTS offres_service (
     id TEXT PRIMARY KEY,
     service_id TEXT NOT NULL REFERENCES services_programme(id),
     etablissement_id TEXT NOT NULL REFERENCES etablissements(id),
     offert BOOLEAN NOT NULL,
     declare_par_id TEXT REFERENCES utilisateurs(id),
     updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     UNIQUE (service_id, etablissement_id)
   )`,

  `CREATE TABLE IF NOT EXISTS eligibilites_service (
     id TEXT PRIMARY KEY,
     service_id TEXT NOT NULL REFERENCES services_programme(id),
     etablissement_id TEXT NOT NULL REFERENCES etablissements(id),
     UNIQUE (service_id, etablissement_id)
   )`,
];

function modifierSchema() {
  const chemin = path.join(__dirname, "..", "prisma", "schema.prisma");
  let contenu = fs.readFileSync(chemin, "utf8");

  if (contenu.includes("model ServiceProgramme")) {
    console.log("schema.prisma : les modèles existent déjà. Rien à faire.");
    return;
  }

  const eol = contenu.includes("\r\n") ? "\r\n" : "\n";

  // Vérifie tous les marqueurs avant de rien écrire.
  for (const r of RELATIONS) {
    if (contenu.split(r.marqueur).length !== 2) {
      throw new Error(`Marqueur introuvable ou en double dans schema.prisma : ${r.marqueur}`);
    }
  }

  fs.writeFileSync(chemin + ".avant-offre-service", contenu, "utf8");

  for (const r of RELATIONS) {
    const lignes = r.ligne.split("\n").join(eol);
    contenu = contenu.replace(r.marqueur, `${lignes}${eol}  ${r.marqueur}`);
  }

  const modeles = NOUVEAUX_MODELES.split("\n").join(eol);
  contenu = contenu.replace(/\s*$/, "") + eol + modeles;

  fs.writeFileSync(chemin, contenu, "utf8");
  console.log("schema.prisma : modèles ajoutés (sauvegarde : schema.prisma.avant-offre-service).");
}

async function main() {
  modifierSchema();

  for (const instruction of SQL) {
    await prisma.$executeRawUnsafe(instruction);
  }

  const tables = await prisma.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.tables
     WHERE table_name IN ('services_programme', 'offres_service', 'eligibilites_service')
     ORDER BY table_name`
  );
  console.log("Base de données : tables présentes =", tables.map((t) => t.table_name).join(", "));
}

main()
  .catch((e) => {
    console.error("ERREUR :", e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());