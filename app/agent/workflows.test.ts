import type { Prisma } from "@prisma/client";
import { SshKeyPairType } from "@prisma/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import type { LogEntry } from "@temporalio/worker";
import { Worker, Runtime, DefaultLogger } from "@temporalio/worker";
import { v4 as uuidv4 } from "uuid";
import { config } from "~/config";
import { printErrors } from "~/test-utils";
import { provideDb } from "~/test-utils/db.server";
import { Token } from "~/token";
import { TEST_USER_PRIVATE_SSH_KEY } from "~/user/test-constants";
import { createTestUser } from "~/user/test-utils";
import { unwrap, waitForPromises } from "~/utils.shared";

import { createActivities } from "./activities";
import { createAgentInjector } from "./agent-injector";
import { HOST_PERSISTENT_DIR } from "./constants";
import { PRIVATE_SSH_KEY, TESTS_REPO_URL } from "./test-constants";
import { execSshCmdThroughProxy } from "./test-utils";
import {
  runBuildfsAndPrebuilds,
  runCreateWorkspace,
  runStartWorkspace,
  runStopWorkspace,
} from "./workflows";

const provideActivities = (
  testFn: (args: {
    activities: Awaited<ReturnType<typeof createActivities>>;
    runId: string;
    db: Prisma.NonTransactionClient;
    injector: ReturnType<typeof createAgentInjector>;
  }) => Promise<void>,
): (() => Promise<void>) => {
  const injector = createAgentInjector({
    [Token.Logger]: function () {
      return new DefaultLogger("ERROR");
    } as unknown as any,
    [Token.Config]: {
      ...config,
      agent: () => ({
        ...config.agent(),
        /**
         * It's a regular buildfs root fs but with docker cache.
         * I generated it manually, by executing a buildfs workflow
         * with the regular buildfs root fs and then copying the
         * resulting drive to the test-buildfs.ext4 file.
         * I also shrank it with `resize2fs -M`.
         * The tests will also work with a regular buildfs root fs,
         * but they will be slower.
         */
        buildfsRootFs: "/srv/jailer/resources/test-buildfs.ext4",
      }),
    },
  });
  const runId = uuidv4();
  return printErrors(
    provideDb(async (db) =>
      testFn({ activities: await createActivities(injector, db), runId, db, injector }),
    ),
  );
};

let testEnv: TestWorkflowEnvironment;

beforeAll(async () => {
  // Use console.log instead of console.error to avoid red output
  // Filter INFO log messages for clearer test output
  Runtime.install({
    logger: new DefaultLogger("WARN", (entry: LogEntry) => {
      if (
        entry.message.includes("InvalidWorkspaceStatusError") &&
        entry.message.includes("runStartWorkspace")
      ) {
        // there is a test case where we expect this error,
        // so in order not to pollute the test output with it,
        // we suppress it
        return;
      }

      // eslint-disable-next-line no-console
      console.log(`[${entry.level}]`, entry.message, entry.meta);
    }),
  });

  testEnv = await TestWorkflowEnvironment.createTimeSkipping({
    client: {
      dataConverter: {
        payloadConverterPath: require.resolve("~/temporal/data-converter"),
      },
    },
  });
});

afterAll(async () => {
  await testEnv?.teardown();
});

test.concurrent("HOST_PERSISTENT_DIR has no trailing slash", async () => {
  expect(HOST_PERSISTENT_DIR).not.toMatch(/\/$/);
});

test.concurrent(
  "runBuildfsAndPrebuilds",
  provideActivities(async ({ activities, injector, db }) => {
    const { client, nativeConnection } = testEnv;
    const worker = await Worker.create({
      connection: nativeConnection,
      taskQueue: "test",
      workflowsPath: require.resolve("./workflows"),
      activities,
      dataConverter: {
        payloadConverterPath: require.resolve("~/temporal/data-converter"),
      },
    });

    const gitService = injector.resolve(Token.GitService);
    const projectService = injector.resolve(Token.ProjectService);
    const pair = await gitService.createSshKeyPair(
      db,
      PRIVATE_SSH_KEY,
      SshKeyPairType.SSH_KEY_PAIR_TYPE_SERVER_CONTROLLED,
    );
    const repo = await gitService.addGitRepository(db, TESTS_REPO_URL, pair.id);
    const updates = await gitService.updateBranches(db, repo.id);
    const projects = await db.$transaction((tdb) =>
      waitForPromises(
        [
          { name: "test1", path: "/" },
          { name: "test2", path: "inner-project" },
        ].map(({ name, path }) =>
          projectService.createProject(tdb, {
            gitRepositoryId: repo.id,
            rootDirectoryPath: path,
            name: name,
          }),
        ),
      ),
    );
    const testBranches = [
      "refs/heads/run-buildfs-and-prebuilds-test-1",
      "refs/heads/run-buildfs-and-prebuilds-test-2",
      "refs/heads/run-buildfs-and-prebuilds-test-3-error",
    ].map((name) => unwrap(updates.newGitBranches.find((b) => b.name === name)));
    await worker.runUntil(async () => {
      const workflowId = uuidv4();
      const result = await client.workflow.execute(runBuildfsAndPrebuilds, {
        workflowId,
        taskQueue: "test",
        retry: { maximumAttempts: 1 },
        args: [
          repo.id,
          testBranches.map((b) => ({ gitBranchId: b.id, gitObjectId: b.gitObjectId })),
        ],
      });
      expect(result).toBeUndefined();

      const project = await db.project.findUniqueOrThrow({
        where: {
          id: projects[0].id,
        },
        include: {
          prebuildEvents: {
            include: {
              gitBranchLinks: {
                include: {
                  gitBranch: true,
                },
              },
            },
          },
        },
      });
      const prebuildEvent = unwrap(
        project.prebuildEvents.find(
          (e) => e.gitBranchLinks.find((l) => l.gitBranchId === testBranches[0].id) != null,
        ),
      );
      const testUser = await createTestUser(db);
      const workspace = await client.workflow.execute(runCreateWorkspace, {
        workflowId: uuidv4(),
        taskQueue: "test",
        retry: { maximumAttempts: 1 },
        args: [
          {
            name: "Test Workspace 😄",
            prebuildEventId: prebuildEvent.id,
            gitBranchId: testBranches[0].id,
            externalId: uuidv4(),
            userId: testUser.id,
          },
        ],
      });
      const startWorkspace = () =>
        client.workflow.execute(runStartWorkspace, {
          workflowId: uuidv4(),
          taskQueue: "test",
          retry: { maximumAttempts: 1 },
          args: [workspace.id],
        });
      const stopWorkspace = () =>
        client.workflow.execute(runStopWorkspace, {
          workflowId: uuidv4(),
          taskQueue: "test",
          retry: { maximumAttempts: 1 },
          args: [workspace.id],
        });

      const workspaceInstance1 = await startWorkspace();
      const sshOutput = await execSshCmdThroughProxy({
        vmIp: workspaceInstance1.vmIp,
        privateKey: TEST_USER_PRIVATE_SSH_KEY,
        cmd: `cat /home/hocus/dev/project/proxy-test.txt`,
      });
      expect(sshOutput.stdout.toString()).toEqual("hello from the tests repository!\n");
      await stopWorkspace();

      const workspaceInstance2 = await startWorkspace();
      const firecrackerService2 = injector.resolve(Token.FirecrackerService)(
        workspaceInstance2.firecrackerInstanceId,
      );
      await firecrackerService2.shutdownVM();
      await stopWorkspace();

      const workspaceInstance3 = await startWorkspace();
      try {
        await startWorkspace();
        throw new Error("Expected startWorkspace to fail");
      } catch (err) {
        expect((err as any)?.cause?.cause?.message).toMatch(
          /Workspace is not in WORKSPACE_STATUS_STOPPED state/,
        );
      }
      const firecrackerService3 = injector.resolve(Token.FirecrackerService)(
        workspaceInstance3.firecrackerInstanceId,
      );
      await firecrackerService3.shutdownVM();
      await firecrackerService3.tryDeleteVmDir();
      await stopWorkspace();
    });
  }),
);
