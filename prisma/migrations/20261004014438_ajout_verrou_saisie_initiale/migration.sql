-- CreateTable
CREATE TABLE "verrous_saisie_initiale" (
    "id" TEXT NOT NULL,
    "etablissement_id" TEXT NOT NULL,
    "programme_id" TEXT,
    "pose_par_id" TEXT NOT NULL,
    "date_verrouillage" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verrous_saisie_initiale_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "verrous_saisie_initiale_etablissement_id_idx" ON "verrous_saisie_initiale"("etablissement_id");

-- AddForeignKey
ALTER TABLE "verrous_saisie_initiale" ADD CONSTRAINT "verrous_saisie_initiale_etablissement_id_fkey" FOREIGN KEY ("etablissement_id") REFERENCES "etablissements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verrous_saisie_initiale" ADD CONSTRAINT "verrous_saisie_initiale_programme_id_fkey" FOREIGN KEY ("programme_id") REFERENCES "programmes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verrous_saisie_initiale" ADD CONSTRAINT "verrous_saisie_initiale_pose_par_id_fkey" FOREIGN KEY ("pose_par_id") REFERENCES "utilisateurs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
