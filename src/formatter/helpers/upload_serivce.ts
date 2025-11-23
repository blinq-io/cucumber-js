/* eslint-disable no-console */
import FormData from 'form-data'
import { createReadStream, existsSync, write, writeFileSync } from 'fs'
import fs from 'fs/promises'
import pLimit from 'p-limit';

import { JsonReport, JsonTestProgress } from './report_generator'
import { axiosClient } from '../../configuration/axios_client'
import path from 'path'
import { createNewTestCase, logReportLink, postUploadReportEvent } from '../bvt_analysis_formatter'
import { ActionEvents, SERVICES_URI } from './constants'

const REPORT_SERVICE_URL = process.env.REPORT_SERVICE_URL ?? URL
const BATCH_SIZE = 10
const MAX_RETRIES = 3
const REPORT_SERVICE_TOKEN =
  process.env.TOKEN ?? process.env.REPORT_SERVICE_TOKEN

export interface RootCauseProps {
  status: boolean
  analysis: string
  failedStep: number
  failClass: string
}

export interface FinishTestCaseResponse {
  status: true
  rootCause: RootCauseProps
  report: JsonTestProgress
}

class RunUploadService {
  constructor(
    private runsApiBaseURL: string,
    private accessToken: string
  ) { }
  async createRunDocument(name: string, env: any) {
    if (process.env.UPLOADREPORTS === 'false') {
      console.log('Skipping report upload as UPLOADREPORTS is set to false')
      return { id: 'local-run', projectId: 'local-project' }
    }
    try {
      const runDocResult = await axiosClient.post(
        this.runsApiBaseURL + '/cucumber-runs/create',
        {
          name: name ? name : 'TEST',
          branch: process.env.GIT_BRANCH ? process.env.GIT_BRANCH : 'main',
          video_id: process.env.VIDEO_ID,
          browser: process.env.BROWSER ? process.env.BROWSER : 'chromium',
          mode:
            process.env.MODE === 'cloud'
              ? 'cloud'
              : process.env.MODE === 'executions'
                ? 'executions'
                : 'local',
          env: { name: env?.name, baseUrl: env?.baseUrl },
        },
        {
          headers: {
            Authorization: 'Bearer ' + this.accessToken,
            'x-source': 'cucumber_js',
          },
        }
      )
      if (runDocResult.status !== 200) {
        throw new Error('Failed to create run document in the server')
      }
      if (runDocResult.data.status !== true) {
        throw new Error('Failed to create run document in the server')
      }
      return runDocResult.data.run
    } catch (error) {
      if (error.response && error.response.status === 403) {
        console.log(
          'Warning: Your trial plan has ended. Cannot create or upload reports.'
        )
        process.exit(1)
      }
      throw new Error('Failed to create run document in the server: ' + error)
    }
  }
  async updateProjectAnalytics(projectId: string) {
    if (process.env.UPLOADREPORTS === 'false') {
      return
    }
    try {
      await axiosClient.post(
        this.runsApiBaseURL + '/project/updateAIRecoveryCount',
        {
          projectId,
        },
        {
          headers: {
            Authorization: 'Bearer ' + this.accessToken,
            'x-source': 'cucumber_js',
          },
        }
      )
    } catch (error) {
      console.error('Failed to update project metadata:', error)
    }
  }
  async upload(formData: FormData) {
    if (process.env.UPLOADREPORTS === 'false') {
      return
    }
    const response = await axiosClient.post(
      this.runsApiBaseURL + '/cucumber-runs/upload',
      formData,
      {
        headers: {
          ...formData.getHeaders(),
          Authorization: 'Bearer ' + this.accessToken,
          'x-source': 'cucumber_js',
        },
      }
    )
    if (response.status === 401) {
      console.log(
        'Warning: Your trial plan has ended. Cannot upload reports and perform retraining'
      )
      throw new Error(
        'Warning: Your trial plan has ended. Cannot upload reports and perform retraining'
      )
    }
    if (response.status !== 200) {
      throw new Error('Failed to upload run to the server')
    }
    if (response.data.status !== true) {
      throw new Error('Failed to upload run to the server')
    }
  }
  async getPreSignedUrls(fileUris: string[], runId: string) {
    if (process.env.UPLOADREPORTS === 'false') {
      return {}
    }
    const response = await axiosClient.post(
      this.runsApiBaseURL + '/cucumber-runs/generateuploadurls',
      {
        fileUris,
        runId,
      },
      {
        headers: {
          Authorization: 'Bearer ' + this.accessToken,
          'x-source': 'cucumber_js',
        },
      }
    )
    if (response.status === 403) {
      console.log(
        'Warning: Your trial plan has ended. Cannot upload reports and perform retraining'
      )
      throw new Error(
        'Warning: Your trial plan has ended. Cannot upload reports and perform retraining'
      )
    }
    if (response.status !== 200) {
      throw new Error('Failed to get pre-signed urls for the files')
    }
    if (response.data.status !== true) {
      throw new Error('Failed to get pre-signed urls for the files')
    }

    return response.data.uploadUrls
  }

  async uploadTestCase(
    testCaseReport: JsonTestProgress,
    runId: string,
    projectId: string,
    reportFolder: string,
    rerunId?: string
  ) {
    if (process.env.UPLOADREPORTS === 'false') return null;

    const fileUris: string[] = [];

    // Collect screenshot + trace + logs
    for (const step of testCaseReport.steps) {
      for (const command of step.commands) {
        if (command.screenshotId) fileUris.push(`screenshots/${command.screenshotId}.png`);
      }
      if (step.traceFilePath) fileUris.push(`trace/${step.traceFilePath}`);
    }
    if (testCaseReport.logFileId) fileUris.push(`editorLogs/testCaseLog_${testCaseReport.logFileId}.log`);
    if (testCaseReport.traceFileId) fileUris.push(`trace/${testCaseReport.traceFileId}`);

    // 🔹 UPLOAD FILES
    try {
      const preSignedUrls = await this.getPreSignedUrls(fileUris, runId);
      await this.uploadFilesInBatches(fileUris, reportFolder, preSignedUrls);
    } catch (error: any) {
      console.error('🟥 Error uploading files:', {
        message: error?.message,
        stack: error?.stack,
      });
    }

    // 🔹 UPLOAD FINAL TEST REPORT
    try {
      const mode = process.env.MODE === 'cloud' ? 'cloud' : process.env.MODE === 'executions' ? 'executions' : 'local';
      let rerunIdFinal = process.env.RETRY_ID || null;
      if (rerunId) rerunIdFinal = rerunId.includes(runId) ? rerunId : `${runId}${rerunId}`;
      if (mode === 'executions') testCaseReport.id = process.env.VIDEO_ID || testCaseReport.id;

      const payload = {
        runId,
        projectId,
        testProgressReport: testCaseReport,
        browser: process.env.BROWSER || 'chromium',
        mode,
        rerunId: rerunIdFinal,
        video_id: process.env.VIDEO_ID,
      };

      const data = await createNewTestCase(payload, this.runsApiBaseURL, this.accessToken);
      await postUploadReportEvent(projectId, this.accessToken);
      logReportLink(runId, projectId, testCaseReport.result);
      return data;
    } catch (e: any) {
      console.error('🟥 Failed to upload test case:', {
        testCaseId: testCaseReport.id,
        message: e?.message,
        status: e?.response?.status,
        responseSnippet: e?.response?.data?.toString()?.slice(0, 300),
        stack: e?.stack,
      });
      return null;
    }
  }

  /**
   * Improving error logging
   * 🔧 Sanitizes Axios errors to avoid dumping Cloudflare HTML (524, 502, etc.)
   */
  private sanitizeError(error: any) {
    // Handle Axios-style errors with response
    if (error?.response) {
      const { data, status } = error.response;

      // If Cloudflare or HTML error page → return a short meaningful message
      if (typeof data === 'string' && data.includes('<!DOCTYPE html')) {
        return `[HTML_ERROR_PAGE] status=${status} - likely Cloudflare timeout or proxy error`;
      }

      // If data is a JSON object, stringify it with indentation for readability
      if (typeof data === 'object') {
        return JSON.stringify(data, null, 2); // Pretty-print the JSON response
      }

      // If response is a string (could be an error message), return it trimmed
      return data?.trim() || `Unknown response data (status: ${status})`;
    }

    // System / network errors (e.g., if Axios cannot reach the server)
    if (error?.message) {
      return error.message;
    }

    // If the error has a stack (for debugging purposes)
    if (error?.stack) {
      return `${error.message}\n${error.stack}`;
    }

    // If it's a generic error object, attempt to stringify it in a readable format
    return JSON.stringify(error, (key, value) => {
      // Avoid circular references or sensitive data
      if (key === 'password' || key === 'accessToken') return '[REDACTED]';
      return value;
    }, 2); // Pretty-print the error object with indentation
  }
  async uploadFileWithRetries(filePath: string, presignedUrl: string) {
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 1000;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const ok = await this.uploadFile(filePath, presignedUrl);
        if (ok) return true;
      } catch (err: any) {
        console.error(`Upload attempt #${attempt} failed for ${filePath}:`, {
          message: err?.message,
          stack: err?.stack,
        });
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
        }
      }
    }
    console.error(`Failed to upload file after ${MAX_RETRIES} retries: ${filePath}`);
    return false;
  }

  async uploadFilesInBatches(fileUris: string[], reportFolder: string, preSignedUrls: Record<string, string>) {
    const MAX_CONCURRENCY = 5;
    const limit = pLimit(MAX_CONCURRENCY);
    const tasks = fileUris
      .filter(uri => preSignedUrls[uri])
      .map(uri => limit(async () => {
        const filePath = path.join(reportFolder, uri);
        if (existsSync(filePath)) {
          await this.uploadFileWithRetries(filePath, preSignedUrls[uri]);
        }
      }));

    await Promise.all(tasks);
  }

  async uploadFile(filePath: string, preSignedUrl: string) {
    if (process.env.UPLOADREPORTS === 'false') {
      return true
    }
    const fileStream = createReadStream(filePath)
    let success = true
    try {
      const fileStats = await fs.stat(filePath)
      const fileSize = fileStats.size

      await axiosClient.put(preSignedUrl, fileStream, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': fileSize,
        },
      })
    } catch (error) {
      if (process.env.MODE === 'executions') {
        const sanitized = this.sanitizeError(error)
        console.error('❌ Error uploading file at:', filePath, 'due to', sanitized);
      }
      success = false
    } finally {
      fileStream.close()
    }
    return success
  }
  async uploadComplete(runId: string, projectId: string) {
    if (process.env.UPLOADREPORTS === 'false') {
      return
    }
    const response = await axiosClient.post(
      this.runsApiBaseURL + '/cucumber-runs/uploadCompletion',
      {
        runId,
        projectId,
        browser: process.env.BROWSER ? process.env.BROWSER : 'chromium',
        mode:
          process.env.MODE === 'cloud'
            ? 'cloud'
            : process.env.MODE === 'executions'
              ? 'executions'
              : 'local',
      },
      {
        headers: {
          Authorization: 'Bearer ' + this.accessToken,
          'x-source': 'cucumber_js',
        },
      }
    )
    if (response.status !== 200) {
      throw new Error('Failed to mark run as complete')
    }
    if (response.data.status !== true) {
      throw new Error('Failed to mark run as complete')
    }

    try {
      await axiosClient.post(
        `${SERVICES_URI.STORAGE}/event`,
        {
          event: ActionEvents.upload_report,
        },
        {
          headers: {
            Authorization: 'Bearer ' + this.accessToken,
            'x-source': 'cucumber_js',
            'x-bvt-project-id': projectId,
          },
        }
      )
    } catch (error) {
      // no event tracking
    }
  }
  async modifyTestCase(
    runId: string,
    projectId: string,
    testProgressReport: JsonTestProgress
  ) {
    if (process.env.UPLOADREPORTS === 'false') {
      return
    }
    try {
      const res = await axiosClient.post(
        this.runsApiBaseURL + '/cucumber-runs/modifyTestCase',
        {
          runId,
          projectId,
          testProgressReport,
        },
        {
          headers: {
            Authorization: 'Bearer ' + this.accessToken,
            'x-source': 'cucumber_js',
          },
        }
      )
      if (res.status !== 200) {
        throw new Error('')
      }
      if (res.data.status !== true) {
        throw new Error('')
      }
      logReportLink(runId, projectId, testProgressReport.result)
    } catch (e) {
      console.error(
        `failed to modify the test case: ${testProgressReport.id} ${e}`
      )
    }
  }
  async createStatus(status: string) {
    if (process.env.UPLOADREPORTS === 'false') {
      return
    }
    if (!process.env.UUID) {
      return
    }

    try {
      await axiosClient.post(
        this.runsApiBaseURL + '/scenarios/status',
        {
          status: { status },
          uuid: process.env.UUID,
        },
        {
          headers: {
            Authorization: 'Bearer ' + this.accessToken,
            'x-source': 'cucumber_js',
          },
        }
      )
    } catch (error) {
      console.log('Failed to send status to the server, ignoring it')
    }
  }
}

export { RunUploadService }
