const { PrismaClient } = require("@prisma/client");

const base = new PrismaClient();

// Regle de securite : tout nouveau compte, et tout mot de passe defini par un
// administrateur ou par un import, doit etre change a la premiere connexion.
// Le changement fait par un utilisateur lui-meme ecrit explicitement false :
// la valeur precisee dans le code est alors respectee.
function forcer(donnees) {
  if (donnees && donnees.doitChangerMotDePasse === undefined) {
    donnees.doitChangerMotDePasse = true;
  }
}

const prisma = base.$extends({
  name: "changement-obligatoire-mot-de-passe",
  query: {
    utilisateur: {
      async create({ args, query }) {
        forcer(args.data);
        return query(args);
      },
      async createMany({ args, query }) {
        if (Array.isArray(args.data)) args.data.forEach(forcer);
        else forcer(args.data);
        return query(args);
      },
      async update({ args, query }) {
        if (args.data && args.data.motDePasseHash !== undefined) forcer(args.data);
        return query(args);
      },
      async updateMany({ args, query }) {
        if (args.data && args.data.motDePasseHash !== undefined) forcer(args.data);
        return query(args);
      },
      async upsert({ args, query }) {
        forcer(args.create);
        if (args.update && args.update.motDePasseHash !== undefined) forcer(args.update);
        return query(args);
      },
    },
  },
});

module.exports = prisma;
