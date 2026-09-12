/*
  Warnings:

  - Made the column `programme_id` on table `produits` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "produits" DROP CONSTRAINT "produits_programme_id_fkey";

-- AlterTable
ALTER TABLE "produits" ALTER COLUMN "programme_id" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "produits" ADD CONSTRAINT "produits_programme_id_fkey" FOREIGN KEY ("programme_id") REFERENCES "programmes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
