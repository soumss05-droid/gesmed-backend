/*
  Warnings:

  - A unique constraint covering the columns `[numero]` on the table `bordereaux_livraison` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[numero]` on the table `requisitions` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "bordereaux_livraison" ADD COLUMN     "numero" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "requisitions" ADD COLUMN     "numero" SERIAL NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "bordereaux_livraison_numero_key" ON "bordereaux_livraison"("numero");

-- CreateIndex
CREATE UNIQUE INDEX "requisitions_numero_key" ON "requisitions"("numero");
