/*
  Warnings:

  - A unique constraint covering the columns `[etablissement_id,numero_lot]` on the table `lots` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "TypeInventaire" AS ENUM ('PONCTUEL', 'PERIODIQUE');

-- CreateTable
CREATE TABLE "inventaires_physiques" (
    "id" TEXT NOT NULL,
    "etablissement_id" TEXT NOT NULL,
    "effectue_par_id" TEXT NOT NULL,
    "date_inventaire" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" "TypeInventaire" NOT NULL,
    "commentaire" TEXT,

    CONSTRAINT "inventaires_physiques_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lignes_inventaire" (
    "id" TEXT NOT NULL,
    "inventaire_id" TEXT NOT NULL,
    "lot_id" TEXT NOT NULL,
    "quantite_systeme" INTEGER NOT NULL,
    "quantite_physique" INTEGER NOT NULL,
    "ecart" INTEGER NOT NULL,

    CONSTRAINT "lignes_inventaire_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lots_etablissement_id_numero_lot_key" ON "lots"("etablissement_id", "numero_lot");

-- AddForeignKey
ALTER TABLE "inventaires_physiques" ADD CONSTRAINT "inventaires_physiques_etablissement_id_fkey" FOREIGN KEY ("etablissement_id") REFERENCES "etablissements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventaires_physiques" ADD CONSTRAINT "inventaires_physiques_effectue_par_id_fkey" FOREIGN KEY ("effectue_par_id") REFERENCES "utilisateurs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lignes_inventaire" ADD CONSTRAINT "lignes_inventaire_inventaire_id_fkey" FOREIGN KEY ("inventaire_id") REFERENCES "inventaires_physiques"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lignes_inventaire" ADD CONSTRAINT "lignes_inventaire_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
