import { describe, expect, it } from "vitest";
import { getProjectPersistenceStatus } from "./persistence-status";

const clip = (
  uploadState: "local" | "uploading" | "processing" | "done" | "error",
  uploadPct = 0,
) => ({ uploadState, uploadPct });

describe("getProjectPersistenceStatus", () => {
  it("marks a fresh idle project without a server id as not saved", () => {
    const status = getProjectPersistenceStatus({
      projectId: null,
      saveState: "idle",
      clips: [clip("local")],
    });

    expect(status.fullySaved).toBe(false);
    expect(status.badge).toContain("NOT SAVED");
  });

  it("reports first-project upload progress as not saved", () => {
    const status = getProjectPersistenceStatus({
      projectId: null,
      saveState: "idle",
      clips: [clip("uploading", 63)],
    });

    expect(status.badge).toBe("NOT SAVED — UPLOADING 63%");
  });

  it("does not mistake a client-generated id for a confirmed cloud project", () => {
    const status = getProjectPersistenceStatus({
      projectId: "client-project-id",
      serverProjectReady: false,
      saveState: "idle",
      localSaveState: "saved",
      clips: [clip("local")],
    });

    expect(status).toMatchObject({
      workSafe: true,
      fullySaved: false,
      badge: "SAVED LOCALLY — WAITING TO UPLOAD",
    });
  });

  it("shows danger when neither the client-id project nor local backup is durable", () => {
    const status = getProjectPersistenceStatus({
      projectId: "client-project-id",
      serverProjectReady: false,
      saveState: "idle",
      localSaveState: "error",
      clips: [clip("local")],
    });

    expect(status).toMatchObject({
      workSafe: false,
      tone: "danger",
      badge: "NOT SAVED — LOCAL BACKUP FAILED",
    });
  });

  it("does not call a project saved while another clip is pending", () => {
    const status = getProjectPersistenceStatus({
      projectId: "project-1",
      saveState: "saved",
      clips: [clip("done"), clip("processing")],
    });

    expect(status.fullySaved).toBe(false);
    expect(status.badge).toContain("PARTIALLY SAVED");
  });

  it("only reports saved when the project and all clips are persisted", () => {
    const status = getProjectPersistenceStatus({
      projectId: "project-1",
      saveState: "idle",
      clips: [clip("done")],
    });

    expect(status).toMatchObject({ fullySaved: true, badge: "SAVED" });
  });

  it("says edits are recoverable while a source upload is still running", () => {
    const status = getProjectPersistenceStatus({
      projectId: "project-1",
      saveState: "saving",
      localSaveState: "saved",
      clips: [clip("uploading", 35)],
    });

    expect(status).toMatchObject({
      workSafe: true,
      fullySaved: false,
      tone: "warning",
      badge: "EDITS SAVED LOCALLY — VIDEO UPLOADING 35%",
    });
    expect(status.message).toContain("restore");
  });

  it("keeps an upload failure separate from saved transcript edits", () => {
    const status = getProjectPersistenceStatus({
      projectId: "project-1",
      saveState: "saved",
      localSaveState: "saved",
      clips: [clip("error", 35)],
    });

    expect(status).toMatchObject({
      workSafe: true,
      fullySaved: false,
      badge: "PROJECT SAVED — SOURCE UPLOAD FAILED",
    });
    expect(status.message).toContain("transcript and edits are safe");
  });

  it("uses a red not-saved state when browser recovery storage fails", () => {
    const status = getProjectPersistenceStatus({
      projectId: null,
      saveState: "error",
      localSaveState: "error",
      clips: [clip("local")],
    });

    expect(status).toMatchObject({
      workSafe: false,
      fullySaved: false,
      tone: "danger",
      badge: "NOT SAVED — LOCAL BACKUP FAILED",
    });
  });

  it("keeps cloud-saved edits safe when only the local backup fails", () => {
    const status = getProjectPersistenceStatus({
      projectId: "project-1",
      saveState: "saved",
      localSaveState: "error",
      clips: [clip("error", 35)],
    });

    expect(status).toMatchObject({
      workSafe: true,
      fullySaved: false,
      tone: "warning",
      badge: "PROJECT SAVED — SOURCE UPLOAD FAILED",
    });
  });
});
