import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupCompleteEvent,
  cleanupReceiptBinding,
  writeCleanupReceipt,
} from "./campaign-cleanup";
import { buildCampaignReport, writeCampaignReport } from "./campaign-report";
import { runVerifyCommand, verifyCampaignReport } from "./qa-verify";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true }))
  );
});

describe("qa:verify evidence boundary", () => {
  it("prints help without reading a report", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(runVerifyCommand(["--help"])).resolves.toBe(0);
    expect(output).toHaveBeenCalledWith("Usage: qa:verify <report-path>");
    output.mockRestore();
  });

  it("rejects an unbound receipt", async () => {
    const directory = await mkdtemp(join("/var/tmp", "celld-verify-"));
    directories.push(directory);
    const reportPath = join(directory, "report.json");
    const receiptPath = join(directory, "cleanup.jsonl");
    const report = buildCampaignReport({
      cleanup: { passed: true, receiptPath },
      command: "chaos",
      runId: "run-1",
      scenarios: [
        { name: "alarm-boundaries", observables: {}, violations: [] },
        { name: "ordering", observables: {}, violations: [] },
        { name: "migration", observables: {}, violations: [] },
      ],
    });
    await writeCleanupReceipt(receiptPath, [
      cleanupCompleteEvent({
        containers: 0,
        ports: 0,
        prefixObjects: 0,
        processes: 0,
        proxyFaults: 0,
        watchPaths: 0,
      }),
    ]);
    await writeCampaignReport(reportPath, report);
    await expect(verifyCampaignReport(reportPath)).rejects.toThrow();
  });

  it("accepts only a receipt bound to the report run and command", async () => {
    const directory = await mkdtemp(join("/var/tmp", "celld-verify-"));
    directories.push(directory);
    const reportPath = join(directory, "report.json");
    const receiptPath = join(directory, "cleanup.jsonl");
    const report = buildCampaignReport({
      cleanup: { passed: true, receiptPath },
      command: "chaos",
      runId: "run-2",
      scenarios: [
        { name: "alarm-boundaries", observables: {}, violations: [] },
        { name: "ordering", observables: {}, violations: [] },
        { name: "migration", observables: {}, violations: [] },
      ],
    });
    await writeCleanupReceipt(
      receiptPath,
      [
        cleanupCompleteEvent({
          containers: 0,
          ports: 0,
          prefixObjects: 0,
          processes: 0,
          proxyFaults: 0,
          watchPaths: 0,
        }),
      ],
      cleanupReceiptBinding("run-2", "chaos")
    );
    await writeCampaignReport(reportPath, report);
    await expect(verifyCampaignReport(reportPath)).resolves.toEqual(report);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await expect(runVerifyCommand([reportPath])).resolves.toBe(1);
    error.mockRestore();
  });

  it("requires every embedded profile receipt to match its run", async () => {
    const directory = await mkdtemp(join("/var/tmp", "celld-verify-"));
    directories.push(directory);
    const reportPath = join(directory, "report.json");
    const receiptPath = join(directory, "cleanup.jsonl");
    const profiles = ["wide", "hot", "mixed", "restart", "soak"];
    const report = buildCampaignReport({
      cleanup: { passed: true, receiptPath },
      command: "profiles",
      runId: "profiles-run",
      scenarios: profiles.map((name) => ({
        name,
        observables: {
          cleanupPath: join(directory, `${name}.cleanup.jsonl`),
          cleanupPassed: true,
          profile: name,
          report: {
            admitted: 1,
            cleanup: { aborted: 0, drained: true, inFlight: 0 },
            completed: 1,
            correct: 1,
            failed: 0,
            incorrect: 0,
          },
          runId: `${name}-run`,
        },
        violations: [],
      })),
    });
    await writeCleanupReceipt(
      receiptPath,
      [emptyCleanup()],
      cleanupReceiptBinding("profiles-run", "profiles")
    );
    await writeCampaignReport(reportPath, report);

    await expect(verifyCampaignReport(reportPath)).rejects.toThrow();
    for (const scenario of report.scenarios) {
      await writeCleanupReceipt(
        String(scenario.observables.cleanupPath),
        [emptyCleanup()],
        cleanupReceiptBinding(String(scenario.observables.runId), "profiles")
      );
    }
    await expect(verifyCampaignReport(reportPath)).resolves.toEqual(report);
  });

  it("resolves moved profile receipts beside the report", async () => {
    const directory = await mkdtemp(join("/var/tmp", "celld-verify-"));
    directories.push(directory);
    const reportPath = join(directory, "report.json");
    const missingDirectory = join(directory, "removed");
    const profiles = ["wide", "hot", "mixed", "restart", "soak"];
    const report = buildCampaignReport({
      cleanup: {
        passed: true,
        receiptPath: join(missingDirectory, "cleanup.jsonl"),
      },
      command: "profiles",
      runId: "profiles-run",
      scenarios: profiles.map((name) => ({
        name,
        observables: {
          cleanupPath: join(missingDirectory, `${name}.cleanup.jsonl`),
          cleanupPassed: true,
          profile: name,
          report: {
            admitted: 1,
            cleanup: { aborted: 0, drained: true, inFlight: 0 },
            completed: 1,
            correct: 1,
            failed: 0,
            incorrect: 0,
          },
          runId: `${name}-run`,
        },
        violations: [],
      })),
    });
    await writeCleanupReceipt(
      join(directory, "cleanup.jsonl"),
      [emptyCleanup()],
      cleanupReceiptBinding("profiles-run", "profiles")
    );
    for (const scenario of report.scenarios) {
      await writeCleanupReceipt(
        join(directory, `${scenario.name}.cleanup.jsonl`),
        [emptyCleanup()],
        cleanupReceiptBinding(String(scenario.observables.runId), "profiles")
      );
    }
    await writeCampaignReport(reportPath, report);

    await expect(verifyCampaignReport(reportPath)).resolves.toEqual(report);
  });

  it("prints the verifier failure cause after the sentinel", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(
      runVerifyCommand(["/var/tmp/missing-report.json"])
    ).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith("CELLD_QA_REPORT_INVALID");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("ENOENT"));
    error.mockRestore();
  });
});

function emptyCleanup() {
  return cleanupCompleteEvent({
    containers: 0,
    ports: 0,
    prefixObjects: 0,
    processes: 0,
    proxyFaults: 0,
    watchPaths: 0,
  });
}
