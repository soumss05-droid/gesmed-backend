-- AlterEnum
ALTER TYPE "TypeNotification" ADD VALUE 'ECART_A_COMPENSER';

-- AlterTable
ALTER TABLE "bl_lignes" ADD COLUMN     "compensation_requise" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "pertes_transit" (
    "id" TEXT NOT NULL,
    "bl_ligne_id" TEXT NOT NULL,
    "produit_id" TEXT NOT NULL,
    "etablissement_expediteur_id" TEXT NOT NULL,
    "etablissement_destinataire_id" TEXT NOT NULL,
    "quantite_perdue" INTEGER NOT NULL,
    "date_constat" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pertes_transit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pertes_transit_bl_ligne_id_key" ON "pertes_transit"("bl_ligne_id");

-- AddForeignKey
ALTER TABLE "pertes_transit" ADD CONSTRAINT "pertes_transit_bl_ligne_id_fkey" FOREIGN KEY ("bl_ligne_id") REFERENCES "bl_lignes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pertes_transit" ADD CONSTRAINT "pertes_transit_produit_id_fkey" FOREIGN KEY ("produit_id") REFERENCES "produits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pertes_transit" ADD CONSTRAINT "pertes_transit_etablissement_expediteur_id_fkey" FOREIGN KEY ("etablissement_expediteur_id") REFERENCES "etablissements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pertes_transit" ADD CONSTRAINT "pertes_transit_etablissement_destinataire_id_fkey" FOREIGN KEY ("etablissement_destinataire_id") REFERENCES "etablissements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
