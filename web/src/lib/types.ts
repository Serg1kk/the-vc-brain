// API types — frozen shapes from the brief §4.
// All request/response types for the founder intake flow.

export type ArtifactKind = "github_repo" | "github_user" | "product" | "other";

export type DeckWarning = "image_only_deck" | "extraction_failed" | null;

export type ApplicationStatus = "screening" | "diligence" | "decision";

export type ExtractionMode = "text_layer" | "vision" | "none";

export interface DeckPayload {
  filename: string;
  mime: string;
  base64: string;
}

export interface ArtifactLink {
  url: string;
  kind: ArtifactKind;
}

export interface ExtraFile {
  filename: string;
  mime: string;
  base64: string;
}

export interface IntakeSubmission {
  intake_submission_id: string;
  company_name: string;
  contact_email: string;
  deck: DeckPayload;
  artifact_links?: ArtifactLink[];
  extra_files?: ExtraFile[];
}

export interface GapQuestion {
  criterion_id: string;
  question: string;
  why: string;
  placeholder: string;
}

export interface IntakeResponse {
  application_id: string;
  company_id: string;
  founder_id: string;
  status: ApplicationStatus;
  deck: {
    extraction_mode: ExtractionMode;
    pages: number;
    chars_extracted: number;
    warning: DeckWarning;
  };
  extra_files_stored: number;
  gap_questions: GapQuestion[];
  estimated_minutes: number;
  verdict_eta_hours: number;
}

export interface GapAnswer {
  criterion_id: string;
  question: string;
  answer_text: string;
}

export interface GapAnswersRequest {
  application_id: string;
  answers: GapAnswer[];
  skipped_criterion_ids: string[];
}

export interface GapAnswersResponse {
  accepted: number;
  skipped: number;
  card_completeness: number;
  status: ApplicationStatus;
  verdict_eta_hours: number;
}

export interface StatusResponse {
  application_id: string;
  company_name: string;
  status: ApplicationStatus;
  submitted_at: string;
  verdict_eta_hours: number;
  card_completeness: number;
  open_questions: number;
}

export type FollowUpGetResponse =
  | {
      valid: true;
      company_name: string;
      asked_by: string;
      note: string | null;
      questions: GapQuestion[];
      estimated_minutes: number;
      already_answered: boolean;
    }
  | {
      valid: false;
      reason: "expired" | "unknown";
    };

export interface FollowUpAnswersRequest {
  token: string;
  answers: GapAnswer[];
  skipped_criterion_ids: string[];
}

export interface ApiErrorPayload {
  code: string;
  message: string;
}

export class ApiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ApiError";
  }
}
