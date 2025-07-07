import { test, expect, beforeEach, afterEach, describe } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { z } from "zod";

type KubectlResponse = {
  content: Array<{
    type: "text";
    text: string;
  }>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateRandomId(): string {
  return Math.random().toString(36).substring(2, 10);
}

describe("test kubectl cp command", () => {
  let transport: StdioClientTransport;
  let client: Client;
  let testNamespace: string;
  const podName = `cp-test-pod-${generateRandomId()}`;
  const NAMESPACE_PREFIX = "test-cp";
  const localOutputDir = path.join(
    os.tmpdir(),
    `cp-test-${generateRandomId()}`
  );

  beforeEach(async () => {
    transport = new StdioClientTransport({
      command: "bun",
      args: ["src/index.ts"],
      stderr: "pipe",
    });

    client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} }
    );

    await client.connect(transport);
    await sleep(3000);

    testNamespace = `${NAMESPACE_PREFIX}-${generateRandomId()}`;

    // Create a test namespace
    try {
      const createNamespaceResponse = (await client.request(
        {
          method: "tools/call",
          params: {
            name: "kubectl_create",
            arguments: {
              resourceType: "namespace",
              name: testNamespace,
            },
          },
        },
        // @ts-ignore - Ignoring type error for now
        z.any()
      )) as KubectlResponse;

      console.log(
        "Namespace creation response:",
        JSON.stringify(createNamespaceResponse)
      );
    } catch (error) {
      console.error("Error creating namespace:", error);
      throw error;
    }

    // Create a test pod with a mounted file
    try {
      const createPodResponse = (await client.request(
        {
          method: "tools/call",
          params: {
            name: "kubectl_create",
            arguments: {
              resourceType: "pod",
              name: podName,
              namespace: testNamespace,
              spec: {
                containers: [
                  {
                    name: "test-container",
                    image: "alpine",
                    command: [
                      "sh",
                      "-c",
                      "echo HelloWorld > /tmp/testfile.txt && sleep 3600",
                    ],
                  },
                ],
              },
            },
          },
        },
        // @ts-ignore - Ignoring type error for now
        z.any()
      )) as KubectlResponse;
      console.log("Pod creation response:", JSON.stringify(createPodResponse));

      await sleep(10000); // Wait for pod to become ready
    } catch (error) {
      console.error("Error creating pod:", error);
      throw error;
    }
  });

  afterEach(async () => {
    try {
      await client.request(
        {
          method: "tools/call",
          params: {
            name: "kubectl_delete",
            arguments: {
              resourceType: "namespace",
              name: testNamespace,
            },
          },
        },
        // @ts-ignore - Ignoring type error for now
        z.any()
      );
      await transport.close();
      await sleep(3000);
      await fs.rm(localOutputDir, { recursive: true, force: true });
    } catch (error) {
      console.error("Error deleting namespace:", error);
    }
  });

  test("should copy file from pod to local machine", async () => {
    await fs.mkdir(localOutputDir, { recursive: true });

    const podFilePath = `${podName}:/tmp/testfile.txt`;
    const localFilePath = path.join(localOutputDir, "copied-testfile.txt");

    const copyResponse = (await client.request(
      {
        method: "tools/call",
        params: {
          name: "kubectl_cp",
          arguments: {
            sourceFilePath: podFilePath,
            destinationFilePath: localFilePath,
          },
        },
      },
      // @ts-ignore - Ignoring type error for now
      z.any()
    )) as KubectlResponse;

    console.log("kubectl_cp response:", copyResponse.content[0].text);
    await sleep(5000); // Wait for the copy to complete

    const fileContents = await fs.readFile(localFilePath, "utf8");
    expect(fileContents.trim()).toBe("HelloWorld");
  }, 60000);
});
