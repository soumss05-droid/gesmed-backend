/*
  Warnings:

  - The values [CAMEC,ADMIN] on the enum `Role` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "Role_new" AS ENUM ('GESTIONNAIRE_CAMEC', 'GESTIONNAIRE_DRS', 'DIRECTEUR_DRS', 'GAS_MOUGHATAA', 'GAS_PROGRAMME_NATIONAL', 'FORMATION_SANITAIRE', 'AUDITEUR');
ALTER TABLE "user_etablissements" ALTER COLUMN "role" TYPE "Role_new" USING ("role"::text::"Role_new");
ALTER TYPE "Role" RENAME TO "Role_old";
ALTER TYPE "Role_new" RENAME TO "Role";
DROP TYPE "Role_old";
COMMIT;

-- AlterTable
ALTER TABLE "etablissements" ADD COLUMN     "programme_id" TEXT;

-- AlterTable
ALTER TABLE "produits" ADD COLUMN     "programme_id" TEXT;

-- AlterTable
ALTER TABLE "utilisateurs" ADD COLUMN     "est_admin_systeme" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "programmes" (
    "id" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "actif" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "programmes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "programmes_code_key" ON "programmes"("code");

-- AddForeignKey
ALTER TABLE "etablissements" ADD CONSTRAINT "etablissements_programme_id_fkey" FOREIGN KEY ("programme_id") REFERENCES "programmes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "produits" ADD CONSTRAINT "produits_programme_id_fkey" FOREIGN KEY ("programme_id") REFERENCES "programmes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
