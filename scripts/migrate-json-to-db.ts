// V2 intentionally has no legacy Course/StudentAccount persistence model.
// Keep this historical entry explicit so operators cannot accidentally invoke stale delegates.
console.error('JSON migration is retired in V2. No data was read or changed. Use the V2 course/template import interfaces and reviewed Prisma migrations.');
process.exitCode = 1;
