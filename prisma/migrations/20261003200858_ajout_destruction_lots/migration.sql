-- CreateEnum
CREATE TYPE "StatutDemandeDestruction" AS ENUM ('EN_ATTENTE', 'VALIDEE', 'REJETEE');

-- AlterEnum
ALTER TYPE "ReferenceType" ADD VALUE 'DESTRUCTION';

-- CreateTable
CREATE TABLE "demandes_destruction_lots" (
    "id" TEXT NOT NULL,
    "lot_id" TEXT NOT NULL,
    "etablissement_id" TEXT NOT NULL,
    "quantite_demandee" INTEGER NOT NULL,
    "motif_demande" TEXT,
    "demandeur_id" TEXT NOT NULL,
    "date_demande" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "statut" "StatutDemandeDestruction" NOT NULL DEFAULT 'EN_ATTENTE',
    "quantite_detruite" INTEGER,
    "validateur_id" TEXT,
    "date_validation" TIMESTAMP(3),
    "commentaire_validation" TEXT,

    CONSTRAINT "demandes_destruction_lots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "demandes_destruction_lots_lot_id_idx" ON "demandes_destruction_lots"("lot_id");

-- CreateIndex
CREATE INDEX "demandes_destruction_lots_etablissement_id_idx" ON "demandes_destruction_lots"("etablissement_id");

-- AddForeignKey
ALTER TABLE "demandes_destruction_lots" ADD CONSTRAINT "demandes_destruction_lots_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "demandes_destruction_lots" ADD CONSTRAINT "demandes_destruction_lots_etablissement_id_fkey" FOREIGN KEY ("etablissement_id") REFERENCES "etablissements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "demandes_destruction_lots" ADD CONSTRAINT "demandes_destruction_lots_demandeur_id_fkey" FOREIGN KEY ("demandeur_id") REFERENCES "utilisateurs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "demandes_destruction_lots" ADD CONSTRAINT "demandes_destruction_lots_validateur_id_fkey" FOREIGN KEY ("validateur_id") REFERENCES "utilisateurs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
