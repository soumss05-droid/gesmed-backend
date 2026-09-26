-- CreateEnum
CREATE TYPE "TypeBeneficiaire" AS ENUM ('PATIENT', 'LABORATOIRE', 'MATERNITE', 'SERVICE', 'AUTRE');

-- CreateEnum
CREATE TYPE "StatutDispensation" AS ENUM ('ACTIVE', 'ANNULEE');

-- CreateTable
CREATE TABLE "dispensations" (
    "id" TEXT NOT NULL,
    "numero" SERIAL NOT NULL,
    "etablissement_id" TEXT NOT NULL,
    "produit_id" TEXT NOT NULL,
    "quantite" INTEGER NOT NULL,
    "type_beneficiaire" "TypeBeneficiaire" NOT NULL,
    "beneficiaire" TEXT,
    "utilisateur_id" TEXT NOT NULL,
    "date_dispensation" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "statut" "StatutDispensation" NOT NULL DEFAULT 'ACTIVE',
    "motif_annulation" TEXT,

    CONSTRAINT "dispensations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dispensations_numero_key" ON "dispensations"("numero");

-- AddForeignKey
ALTER TABLE "dispensations" ADD CONSTRAINT "dispensations_etablissement_id_fkey" FOREIGN KEY ("etablissement_id") REFERENCES "etablissements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispensations" ADD CONSTRAINT "dispensations_produit_id_fkey" FOREIGN KEY ("produit_id") REFERENCES "produits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispensations" ADD CONSTRAINT "dispensations_utilisateur_id_fkey" FOREIGN KEY ("utilisateur_id") REFERENCES "utilisateurs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
