import { accountFields, hashPassword, verifyPassword, publicUser } from '../accounts.js';
import { httpError } from '../http.js';
import { equalSecret } from '../auth.js';
import { DEFAULT_ACCENT, isAccent } from '../../src/lib/accents.js';

const fields = data => {
  try {
    return accountFields(data);
  } catch (error) {
    throw httpError(400, 'invalid_account', error.message);
  }
};
const passwordHash = async password => {
  try {
    return await hashPassword(password);
  } catch (error) {
    throw httpError(400, 'invalid_password', error.message);
  }
};

// Session de l’interface, premier administrateur, invitations et gestion des membres.
export function accountRoutes({ store, auth, guards }) {
  const sameOrigin = ctx => auth.requireSameOrigin(ctx.req);
  return [
    {
      path: '/api/v1/session',
      guard: sameOrigin,
      methods: {
        GET(ctx) {
          const user = auth.currentUser(ctx.req);
          ctx.send(200, {
            authenticated: !!user,
            user,
            requiresLogin: true,
            needsSetup: !store.hasUsers(),
            ...(user ? { preferences: store.preferences(user.id) } : {}),
          });
        },
        async POST(ctx) {
          const data = await ctx.body();
          const email = typeof data?.email === 'string' ? data.email.trim().toLowerCase() : '';
          auth.loginLimit(ctx.req, email);
          const user = store.userByEmail(email);
          const valid = await verifyPassword(data?.password, user?.password_hash);
          // Relire le compte après le calcul du mot de passe : il a pu être désactivé ou modifié entre-temps.
          if (
            !valid ||
            !user?.active ||
            !store.userById(user.id)?.active ||
            store.userById(user.id).password_hash !== user.password_hash
          )
            throw httpError(401, 'unauthorized', 'Adresse e-mail ou mot de passe incorrect.');
          const account = publicUser(user);
          auth.newSession(ctx.res, account);
          ctx.send(200, { authenticated: true, user: account });
        },
        DELETE(ctx) {
          auth.requireAccount(ctx.req);
          store.deleteSession(auth.sessionToken(ctx.req));
          ctx.res.setHeader('Set-Cookie', auth.cookie('', 0));
          ctx.send(200, { authenticated: false });
        },
      },
    },
    {
      path: '/api/v1/accounts/setup',
      guard: sameOrigin,
      methods: {
        async POST(ctx) {
          auth.loginLimit(ctx.req);
          if (store.hasUsers())
            throw httpError(409, 'already_initialized', 'Le compte administrateur a déjà été créé.');
          const data = await ctx.body();
          if (auth.ownerToken && !equalSecret(typeof data?.token === 'string' ? data.token : '', auth.ownerToken))
            throw httpError(401, 'unauthorized', 'Clé d’initialisation incorrecte.');
          const user = store.bootstrapUser(fields(data), await passwordHash(data.password));
          auth.newSession(ctx.res, user);
          ctx.send(201, { authenticated: true, user });
        },
      },
    },
    {
      path: '/api/v1/accounts/accept',
      guard: sameOrigin,
      methods: {
        async POST(ctx) {
          auth.loginLimit(ctx.req);
          const data = await ctx.body();
          if (typeof data?.token !== 'string' || data.token.length !== 64 || !store.invitation(data.token))
            throw httpError(400, 'invalid_invitation', 'Invitation invalide, expirée ou déjà utilisée.');
          const pending = store.invitation(data.token);
          const account = fields({ email: pending.email, name: data.name });
          const user = store.acceptInvitation(data.token, account.name, await passwordHash(data.password));
          auth.newSession(ctx.res, user);
          ctx.send(200, { authenticated: true, user });
        },
      },
    },
    {
      path: '/api/v1/accounts/password',
      methods: {
        async POST(ctx) {
          const user = auth.requireAccount(ctx.req);
          auth.loginLimit(ctx.req);
          const data = await ctx.body();
          if (!(await verifyPassword(data?.currentPassword, store.userById(user.id)?.password_hash)))
            throw httpError(401, 'unauthorized', 'Mot de passe actuel incorrect.');
          const hashed = await passwordHash(data.password);
          // La session a pu être révoquée pendant le calcul du nouveau mot de passe.
          auth.requireAccount(ctx.req);
          store.changePassword(user.id, hashed, user);
          auth.newSession(ctx.res, user);
          ctx.send(200, { authenticated: true, user });
        },
      },
    },
    {
      // Apparence personnelle : seul le compte connecté lit et modifie sa couleur dominante.
      path: '/api/v1/accounts/preferences',
      guard: guards.account,
      methods: {
        GET: ctx => ctx.send(200, { data: store.preferences(ctx.user.id) }),
        async PUT(ctx) {
          const data = await ctx.body();
          const accent = data?.accent === null ? DEFAULT_ACCENT : data?.accent;
          if (!isAccent(accent))
            throw httpError(400, 'invalid_preferences', 'Choisissez une couleur de la palette proposée.');
          ctx.send(200, { data: store.setAccent(ctx.user.id, accent) });
        },
      },
    },
    {
      path: '/api/v1/users',
      guard: guards.admin,
      methods: {
        GET: ctx => ctx.send(200, { data: store.users() }),
        POST: async ctx => ctx.send(201, { data: store.inviteUser(fields(await ctx.body()), ctx.user) }),
      },
    },
    {
      path: '/api/v1/users/:userId',
      guard: guards.admin,
      methods: {
        async PATCH(ctx) {
          const data = await ctx.body();
          if (typeof data?.active !== 'boolean')
            throw httpError(400, 'invalid_account', 'active doit être un booléen.');
          ctx.send(200, { data: store.setActive(ctx.params.userId, data.active, ctx.user) });
        },
        DELETE: ctx => ctx.send(200, { data: store.deleteUser(ctx.params.userId, ctx.user) }),
      },
    },
    {
      path: '/api/v1/users/:userId/invitation',
      guard: guards.admin,
      methods: { POST: ctx => ctx.send(201, { data: store.inviteUser(null, ctx.user, ctx.params.userId) }) },
    },
  ];
}
