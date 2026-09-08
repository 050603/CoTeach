import { z } from "zod";
import { prisma } from "../src/lib/db/client";
import { hashPassword } from "../src/lib/auth/password";

const ArgsSchema = z.object({
  username: z.string().trim().min(3).max(64).regex(/^[a-z0-9._-]+$/i),
  displayName: z.string().trim().min(1).max(80),
  password: z.string().min(10).max(256),
});

async function main() {
  const args = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index]?.replace(/^--/, "");
    const value = process.argv[index + 1];
    if (key && value) args.set(key, value);
  }
  const parsed = ArgsSchema.safeParse({
    username: args.get("username"),
    displayName: args.get("display-name"),
    password: process.env.OPENPBL_INITIAL_TEACHER_PASSWORD,
  });
  if (!parsed.success) {
    throw new Error(
      "Usage: set OPENPBL_INITIAL_TEACHER_PASSWORD (10+ chars), then run " +
        "pnpm admin:init-teacher --username <name> --display-name <name>",
    );
  }
  const count = await prisma.teacher.count();
  if (count > 0) {
    throw new Error("Teacher initialization refused: at least one teacher already exists.");
  }
  const passwordHash = await hashPassword(parsed.data.password);
  const teacher = await prisma.$transaction(async (tx) => {
    const created = await tx.teacher.create({
      data: {
        username: parsed.data.username,
        displayName: parsed.data.displayName,
        passwordHash,
      },
      select: { id: true, username: true, displayName: true, sessionVersion: true },
    });
    await tx.user.create({
      data: {
        id: created.id,
        username: created.username,
        usernameKey: created.username.normalize("NFKC").trim().toLocaleLowerCase("en-US"),
        displayName: created.displayName,
        passwordHash,
        role: "teacher",
        sessionVersion: created.sessionVersion,
      },
    });
    return created;
  });
  process.stdout.write(
    `Created initial teacher ${teacher.username} (${teacher.id}) for ${teacher.displayName}.\n`,
  );
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
