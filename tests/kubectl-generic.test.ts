import { expect, test, describe, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import os from "os";
import path from "path";
import fs from "fs/promises";

// Define the response type for easier use in tests
type KubectlResponse = {
  content: Array<{
    type: "text";
    text: string;
  }>;
};

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateRandomId(): string {
  return Math.random().toString(36).substring(2, 10);
}

// Helper function to retry operations that might be flaky
async function retry<T>(
  operation: () => Promise<T>,
  maxRetries: number = 2,
  delayMs: number = 1000
): Promise<T> {
  let lastError: Error | unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      console.warn(
        `Attempt ${attempt}/${maxRetries} failed. Retrying in ${delayMs}ms...`
      );
      await sleep(delayMs);
    }
  }

  throw lastError;
}

describe("kubectl_generic command", () => {
  let transport: StdioClientTransport;
  let client: Client;
  const testNamespace = "generic-test-" + Math.random().toString(36).substring(2, 7);

  beforeEach(async () => {
    transport = new StdioClientTransport({
      command: "bun",
      args: ["src/index.ts"],
      stderr: "pipe",
    });

    client = new Client(
      {
        name: "test-client",
        version: "1.0.0",
      },
      {
        capabilities: {},
      }
    );

    await client.connect(transport);
    await sleep(1000);
  });

  afterEach(async () => {
    try {
      // Delete the test namespace if it exists
      try {
        await client.request(
          {
            method: "tools/call",
            params: {
              name: "kubectl_delete",
              arguments: {
                resourceType: "namespace",
                name: testNamespace,
                force: true
              },
            },
          },
          KubectlResponseSchema
        );
      } catch (e) {
        // Ignore error if namespace doesn't exist
      }

      await transport.close();
      await sleep(1000);
    } catch (e) {
      console.error("Error during cleanup:", e);
    }
  });

  test("kubectl_generic can create a namespace", async () => {
    const result = await retry(async () => {
      const response = await client.request(
        {
          method: "tools/call",
          params: {
            name: "kubectl_generic",
            arguments: {
              command: "create",
              resourceType: "namespace",
              name: testNamespace
            },
          },
        },
        z.any()
      ) as KubectlResponse;
      return response;
    });

    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain(`created`);
    
    // Verify the namespace was created
    const getResult = await client.request(
      {
        method: "tools/call",
        params: {
          name: "kubectl_get",
          arguments: {
            resourceType: "namespace",
            name: testNamespace
          },
        },
      },
      z.any()
    ) as KubectlResponse;
    
    expect(getResult.content[0].type).toBe("text");
    expect(getResult.content[0].text).toContain(testNamespace);
  });

  test("kubectl_generic can get resource with flags", async () => {
    // First, let's create a configmap to test
    const configMapName = "generic-test-cm";
    
    // Create a configmap using kubectl_generic
    await retry(async () => {
      await client.request(
        {
          method: "tools/call",
          params: {
            name: "kubectl_generic",
            arguments: {
              command: "create",
              resourceType: "configmap",
              name: configMapName,
              namespace: "default",
              flags: {
                "from-literal": "key1=value1",
              }
            },
          },
        },
        z.any()
      );
    });
    
    // Now get the configmap using kubectl_generic with output flag
    const getResult = await client.request(
      {
        method: "tools/call",
        params: {
          name: "kubectl_generic",
          arguments: {
            command: "get",
            resourceType: "configmap",
            name: configMapName,
            namespace: "default",
            outputFormat: "json"
          },
        },
      },
      z.any()
    ) as KubectlResponse;
    
    expect(getResult.content[0].type).toBe("text");
    const configMap = JSON.parse(getResult.content[0].text);
    expect(configMap.metadata.name).toBe(configMapName);
    expect(configMap.data.key1).toBe("value1");
    
    // Clean up
    await client.request(
      {
        method: "tools/call",
        params: {
          name: "kubectl_delete",
          arguments: {
            resourceType: "configmap",
            name: configMapName,
            namespace: "default"
          },
        },
      },
      z.any()
    );
  });

  test("kubectl_generic can handle additional arguments", async () => {
    // Get all pods in kube-system namespace with custom arguments
    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name: "kubectl_generic",
          arguments: {
            command: "get",
            resourceType: "pods",
            namespace: "kube-system",
            outputFormat: "wide",
            args: ["-l", "k8s-app=kube-dns"]  // Label selector as additional args
          },
        },
      },
      z.any()
    ) as KubectlResponse;
    
    expect(result.content[0].type).toBe("text");
    // The response should include pods with the label k8s-app=kube-dns
    // This is usually coredns in most K8s clusters
    expect(result.content[0].text).toMatch(/NAME\s+READY\s+STATUS/);
  });

  test("kubectl_generic can handle multiple operations in sequence", async () => {
    const testConfigMap = "sequence-test-cm";
    
    // 1. Create a configmap
    await client.request(
      {
        method: "tools/call",
        params: {
          name: "kubectl_generic",
          arguments: {
            command: "create",
            resourceType: "configmap",
            name: testConfigMap,
            namespace: "default",
            flags: {
              "from-literal": "foo=bar"
            }
          },
        },
      },
      z.any()
    );
    
    // 2. Get the configmap
    const getResult = await client.request(
      {
        method: "tools/call",
        params: {
          name: "kubectl_generic",
          arguments: {
            command: "get",
            resourceType: "configmap",
            name: testConfigMap,
            namespace: "default",
            outputFormat: "json"
          },
        },
      },
      z.any()
    ) as KubectlResponse;
    
    const configMap = JSON.parse(getResult.content[0].text);
    expect(configMap.data.foo).toBe("bar");
    
    // 3. Annotate the configmap
    await client.request(
      {
        method: "tools/call",
        params: {
          name: "kubectl_generic",
          arguments: {
            command: "annotate",
            resourceType: "configmap",
            name: testConfigMap,
            namespace: "default",
            args: ["test-annotation=true"]
          },
        },
      },
      z.any()
    );
    
    // 4. Get the configmap again to check annotation
    const getUpdatedResult = await client.request(
      {
        method: "tools/call",
        params: {
          name: "kubectl_generic",
          arguments: {
            command: "get",
            resourceType: "configmap",
            name: testConfigMap,
            namespace: "default",
            outputFormat: "json"
          },
        },
      },
      z.any()
    ) as KubectlResponse;
    
    const updatedConfigMap = JSON.parse(getUpdatedResult.content[0].text);
    expect(updatedConfigMap.metadata.annotations["test-annotation"]).toBe("true");
    
    // 5. Delete the configmap
    const deleteResult = await client.request(
      {
        method: "tools/call",
        params: {
          name: "kubectl_generic",
          arguments: {
            command: "delete",
            resourceType: "configmap",
            name: testConfigMap,
            namespace: "default"
          },
        },
      },
      z.any()
    ) as KubectlResponse;
    
    expect(deleteResult.content[0].text).toContain("deleted");
  });

  test("kubectl_generic handles errors gracefully", async () => {
    const nonExistentResource = "non-existent-resource-" + Date.now();
    
    try {
      await client.request(
        {
          method: "tools/call",
          params: {
            name: "kubectl_generic",
            arguments: {
              command: "get",
              resourceType: "pod",
              name: nonExistentResource,
              namespace: "default"
            },
          },
        },
        z.any()
      );
      
      // If we get here, the test has failed
      expect(true).toBe(false); // This should not execute
    } catch (error: any) {
      // Expect an error response
      expect(error.message).toContain("Failed to execute kubectl command");
    }
  });
}); 

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

    // Create namespace
    try {
      const createNamespaceResponse = (await client.request(
        {
          method: "tools/call",
          params: {
            name: "kubectl_generic",
            arguments: {
              command: "create",
              resourceType: "namespace",
              name: testNamespace,
            },
          },
        },
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

    // Create a test pod with a file
    try {
      // Create pod manifest as YAML string
      const podManifest = `apiVersion: v1
kind: Pod
metadata:
  name: ${podName}
  namespace: ${testNamespace}
spec:
  containers:
  - name: test-container
    image: busybox
    command: ["sh", "-c", "echo 'HelloWorld' > /tmp/testfile.txt && sleep 3600"]
  restartPolicy: Never`;

      // Write pod manifest to temp file
      const manifestPath = path.join(
        os.tmpdir(),
        `pod-${generateRandomId()}.yaml`
      );
      await fs.writeFile(manifestPath, podManifest);

      // Apply the pod manifest using kubectl_generic
      const createPodResponse = (await client.request(
        {
          method: "tools/call",
          params: {
            name: "kubectl_generic",
            arguments: {
              command: "apply",
              args: ["-f", manifestPath],
            },
          },
        },
        z.any()
      )) as KubectlResponse;

      console.log("Pod creation response:", JSON.stringify(createPodResponse));

      // Wait for pod to be ready
      let podReady = false;
      let attempts = 0;
      const maxAttempts = 30;

      while (!podReady && attempts < maxAttempts) {
        try {
          const podStatus = (await client.request(
            {
              method: "tools/call",
              params: {
                name: "kubectl_generic",
                arguments: {
                  command: "get",
                  resourceType: "pod",
                  name: podName,
                  namespace: testNamespace,
                  outputFormat: "json",
                },
              },
            },
            z.any()
          )) as KubectlResponse;

          const pod = JSON.parse(podStatus.content[0].text);
          if (pod.status.phase === "Running") {
            // Also check if containers are ready
            const containerStatuses = pod.status.containerStatuses || [];
            const allReady = containerStatuses.every(
              (status: any) => status.ready
            );
            if (allReady) {
              podReady = true;
            }
          }
        } catch (error) {
          console.log(`Attempt ${attempts + 1}: Pod not ready yet`);
        }

        if (!podReady) {
          await sleep(2000);
          attempts++;
        }
      }

      if (!podReady) {
        throw new Error("Pod failed to become ready within timeout");
      }

      console.log("Pod is ready!");

      // Clean up manifest file
      await fs.unlink(manifestPath);
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
            name: "kubectl_generic",
            arguments: {
              command: "delete",
              resourceType: "namespace",
              name: testNamespace,
              flags: {
                force: true,
                "grace-period": "0",
              },
            },
          },
        },
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

    const localFilePath = path.join(localOutputDir, "copied-testfile.txt");

    // Use kubectl_generic to copy file from pod to local machine
    const copyResponse = (await client.request(
      {
        method: "tools/call",
        params: {
          name: "kubectl_generic",
          arguments: {
            command: "cp",
            args: [
              `${testNamespace}/${podName}:/tmp/testfile.txt`,
              localFilePath,
            ],
          },
        },
      },
      z.any()
    )) as KubectlResponse;

    console.log("kubectl_generic cp response:", copyResponse.content[0].text);
    await sleep(2000);

    // Verify the file was copied and contains expected content
    const fileContents = await fs.readFile(localFilePath, "utf8");
    expect(fileContents.trim()).toBe("HelloWorld");
  }, 120000); // Increased timeout to 2 minutes

  test("should copy file from local machine to pod", async () => {
    await fs.mkdir(localOutputDir, { recursive: true });

    const localFilePath = path.join(localOutputDir, "test-upload.txt");
    const testContent = "This is a test file for upload";

    // Create a local file to upload
    await fs.writeFile(localFilePath, testContent);

    // Use kubectl_generic to copy file from local machine to pod
    const copyResponse = (await client.request(
      {
        method: "tools/call",
        params: {
          name: "kubectl_generic",
          arguments: {
            command: "cp",
            args: [
              localFilePath,
              `${testNamespace}/${podName}:/tmp/uploaded-file.txt`,
            ],
          },
        },
      },
      z.any()
    )) as KubectlResponse;

    console.log(
      "kubectl_generic cp upload response:",
      copyResponse.content[0].text
    );
    await sleep(2000);

    // Verify the file was uploaded by reading it back from the pod
    const catResponse = (await client.request(
      {
        method: "tools/call",
        params: {
          name: "kubectl_generic",
          arguments: {
            command: "exec",
            args: [
              `-n=${testNamespace}`,
              podName,
              "--",
              "cat",
              "/tmp/uploaded-file.txt",
            ],
          },
        },
      },
      z.any()
    )) as KubectlResponse;

    expect(catResponse.content[0].text.trim()).toBe(testContent);
  }, 120000);
});
