import { config } from 'dotenv'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { hash } from '@node-rs/argon2'
import { users, roles, userRoles } from './schema'

// Idempotent seed: creates the roles and one admin. Safe to run repeatedly.
// Locally the admin is demo@example.com / Password123. Anywhere else, set
// SEED_ADMIN_PASSWORD (scripts/setup.sh generates one); with NODE_ENV=production
// the seed refuses to fall back to the published password.
config({ path: '.env' })

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required to seed')

const seedPassword = process.env.SEED_ADMIN_PASSWORD?.trim()
if (!seedPassword && process.env.NODE_ENV === 'production') {
  throw new Error(
    'SEED_ADMIN_PASSWORD is required to seed with NODE_ENV=production',
  )
}

const DEMO = {
  name: 'Demo User',
  email: process.env.SEED_ADMIN_EMAIL?.trim() || 'demo@example.com',
  password: seedPassword || 'Password123',
}

async function main() {
  const client = postgres(databaseUrl!, { max: 1 })
  const db = drizzle(client, { schema: { users, roles, userRoles } })

  // Ensure roles exist
  let adminRole = await db.query.roles.findFirst({
    where: eq(roles.name, 'admin'),
  })

  if (!adminRole) {
    const [created] = await db
      .insert(roles)
      .values({ name: 'admin', description: 'Full administrative access' })
      .returning()
    adminRole = created
    console.log(`✅ Created role: admin`)
  }

  let memberRole = await db.query.roles.findFirst({
    where: eq(roles.name, 'member'),
  })

  if (!memberRole) {
    const [created] = await db
      .insert(roles)
      .values({ name: 'member', description: 'Standard member access' })
      .returning()
    memberRole = created
    console.log(`✅ Created role: member`)
  }

  let viewerRole = await db.query.roles.findFirst({
    where: eq(roles.name, 'viewer'),
  })

  if (!viewerRole) {
    const [created] = await db
      .insert(roles)
      .values({ name: 'viewer', description: 'Read-only access' })
      .returning()
    viewerRole = created
    console.log(`✅ Created role: viewer`)
  }

  // Seed demo user
  let existing = await db.query.users.findFirst({
    where: eq(users.email, DEMO.email),
  })

  if (existing) {
    console.log(`ℹ️  Demo user already exists (${DEMO.email})`)
  } else {
    const hashedPassword = await hash(DEMO.password, {
      memoryCost: 19_456,
      timeCost: 2,
      outputLen: 32,
      parallelism: 1,
    })
    const [user] = await db
      .insert(users)
      .values({
        name: DEMO.name,
        email: DEMO.email,
        hashedPassword,
      })
      .returning()
    console.log(
      `✅ Seeded demo user: ${DEMO.email}${seedPassword ? '' : ' / Password123'}`,
    )
    existing = user
  }

  // Assign admin role to demo user
  if (existing && adminRole) {
    const hasAdminRole = await db.query.userRoles.findFirst({
      where: (ur, { and, eq }) =>
        and(eq(ur.userId, existing.id), eq(ur.roleId, adminRole.id)),
    })

    if (!hasAdminRole) {
      await db.insert(userRoles).values({
        userId: existing.id,
        roleId: adminRole.id,
      })
      console.log(`✅ Assigned admin role to demo user`)
    } else {
      console.log(`ℹ️  Demo user already has admin role`)
    }
  }

  await client.end()
  process.exit(0)
}

main().catch((err) => {
  console.error('❌ Seed failed', err)
  process.exit(1)
})
