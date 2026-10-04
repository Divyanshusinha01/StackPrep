
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "public": {
          Tables: {
            "evaluations": {
                  Row: {
                    "category": string,"created_at": string,"discrepancy": boolean,"discrepancy_detail": string | null,"gaps": NonNullable<Json>,"id": string,"interview_id": string,"message_id": string,"rating": string | null,"repo_evidence": NonNullable<Json>,"score": number | null,"strengths": NonNullable<Json>,"user_id": string
                  }
                  Insert: {
                    "category": string,"created_at"?: string,"discrepancy"?: boolean,"discrepancy_detail"?: string | null,"gaps"?: NonNullable<Json>,"id"?: string,"interview_id": string,"message_id": string,"rating"?: string | null,"repo_evidence"?: NonNullable<Json>,"score"?: number | null,"strengths"?: NonNullable<Json>,"user_id": string
                  }
                  Update: {
                    "category"?: string,"created_at"?: string,"discrepancy"?: boolean,"discrepancy_detail"?: string | null,"gaps"?: NonNullable<Json>,"id"?: string,"interview_id"?: string,"message_id"?: string,"rating"?: string | null,"repo_evidence"?: NonNullable<Json>,"score"?: number | null,"strengths"?: NonNullable<Json>,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "evaluations_interview_id_user_id_fkey"
      columns: ["interview_id","user_id"]
isOneToOne: false
      referencedRelation: "interviews"
      referencedColumns: ["id","user_id"]
    },{
      foreignKeyName: "evaluations_message_id_interview_id_fkey"
      columns: ["message_id","interview_id"]
isOneToOne: false
      referencedRelation: "interview_messages"
      referencedColumns: ["id","interview_id"]
    }
                  ]
                },"github_connections": {
                  Row: {
                    "account_login": string,"account_type": string | null,"created_at": string,"github_user_id": number,"id": string,"installation_id": number,"permissions": NonNullable<Json>,"repository_selection": string | null,"suspended_at": string | null,"updated_at": string,"user_id": string
                  }
                  Insert: {
                    "account_login": string,"account_type"?: string | null,"created_at"?: string,"github_user_id": number,"id"?: string,"installation_id": number,"permissions"?: NonNullable<Json>,"repository_selection"?: string | null,"suspended_at"?: string | null,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "account_login"?: string,"account_type"?: string | null,"created_at"?: string,"github_user_id"?: number,"id"?: string,"installation_id"?: number,"permissions"?: NonNullable<Json>,"repository_selection"?: string | null,"suspended_at"?: string | null,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "github_connections_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"interview_events": {
                  Row: {
                    "created_at": string,"event_type": Database["public"]['Enums']["event_type"],"id": string,"interview_id": string,"occurred_at": string,"payload": NonNullable<Json>,"sequence": number,"user_id": string
                  }
                  Insert: {
                    "created_at"?: string,"event_type": Database["public"]['Enums']["event_type"],"id"?: string,"interview_id": string,"occurred_at"?: string,"payload"?: NonNullable<Json>,"sequence": number,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"event_type"?: Database["public"]['Enums']["event_type"],"id"?: string,"interview_id"?: string,"occurred_at"?: string,"payload"?: NonNullable<Json>,"sequence"?: number,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "interview_events_interview_id_user_id_fkey"
      columns: ["interview_id","user_id"]
isOneToOne: false
      referencedRelation: "interviews"
      referencedColumns: ["id","user_id"]
    }
                  ]
                },"interview_messages": {
                  Row: {
                    "content": string,"created_at": string,"id": string,"interview_id": string,"metadata": NonNullable<Json>,"question_message_id": string | null,"role": Database["public"]['Enums']["message_role"],"sequence": number,"user_id": string
                  }
                  Insert: {
                    "content": string,"created_at"?: string,"id"?: string,"interview_id": string,"metadata"?: NonNullable<Json>,"question_message_id"?: string | null,"role": Database["public"]['Enums']["message_role"],"sequence": number,"user_id": string
                  }
                  Update: {
                    "content"?: string,"created_at"?: string,"id"?: string,"interview_id"?: string,"metadata"?: NonNullable<Json>,"question_message_id"?: string | null,"role"?: Database["public"]['Enums']["message_role"],"sequence"?: number,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "interview_messages_interview_id_user_id_fkey"
      columns: ["interview_id","user_id"]
isOneToOne: false
      referencedRelation: "interviews"
      referencedColumns: ["id","user_id"]
    },{
      foreignKeyName: "interview_messages_question_message_id_interview_id_fkey"
      columns: ["question_message_id","interview_id"]
isOneToOne: false
      referencedRelation: "interview_messages"
      referencedColumns: ["id","interview_id"]
    }
                  ]
                },"interview_state": {
                  Row: {
                    "coverage_map": NonNullable<Json>,"created_at": string,"interview_id": string,"plan": NonNullable<Json>,"strategy": NonNullable<Json>,"updated_at": string,"version": number
                  }
                  Insert: {
                    "coverage_map"?: NonNullable<Json>,"created_at"?: string,"interview_id": string,"plan"?: NonNullable<Json>,"strategy"?: NonNullable<Json>,"updated_at"?: string,"version"?: number
                  }
                  Update: {
                    "coverage_map"?: NonNullable<Json>,"created_at"?: string,"interview_id"?: string,"plan"?: NonNullable<Json>,"strategy"?: NonNullable<Json>,"updated_at"?: string,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "interview_state_interview_id_fkey"
      columns: ["interview_id"]
isOneToOne: true
      referencedRelation: "interviews"
      referencedColumns: ["id"]
    }
                  ]
                },"interviews": {
                  Row: {
                    "created_at": string,"ended_at": string | null,"id": string,"integrity_warning_count": number,"interview_number": number,"last_active_at": string | null,"repository_commit_sha": string,"started_at": string | null,"status": Database["public"]['Enums']["interview_status"],"termination_detail": string | null,"termination_reason": Database["public"]['Enums']["termination_reason"] | null,"updated_at": string,"user_id": string,"workspace_id": string
                  }
                  Insert: {
                    "created_at"?: string,"ended_at"?: string | null,"id"?: string,"integrity_warning_count"?: number,"interview_number": number,"last_active_at"?: string | null,"repository_commit_sha": string,"started_at"?: string | null,"status"?: Database["public"]['Enums']["interview_status"],"termination_detail"?: string | null,"termination_reason"?: Database["public"]['Enums']["termination_reason"] | null,"updated_at"?: string,"user_id": string,"workspace_id": string
                  }
                  Update: {
                    "created_at"?: string,"ended_at"?: string | null,"id"?: string,"integrity_warning_count"?: number,"interview_number"?: number,"last_active_at"?: string | null,"repository_commit_sha"?: string,"started_at"?: string | null,"status"?: Database["public"]['Enums']["interview_status"],"termination_detail"?: string | null,"termination_reason"?: Database["public"]['Enums']["termination_reason"] | null,"updated_at"?: string,"user_id"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "interviews_workspace_id_user_id_fkey"
      columns: ["workspace_id","user_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id","user_id"]
    }
                  ]
                },"jobs": {
                  Row: {
                    "created_at": string,"error_code": string | null,"error_message": string | null,"finished_at": string | null,"id": string,"inngest_event_id": string | null,"inngest_run_id": string | null,"interview_id": string | null,"progress": number,"repository_commit_sha": string | null,"stage": string | null,"started_at": string | null,"status": Database["public"]['Enums']["job_status"],"type": Database["public"]['Enums']["job_type"],"updated_at": string,"user_id": string,"workspace_id": string
                  }
                  Insert: {
                    "created_at"?: string,"error_code"?: string | null,"error_message"?: string | null,"finished_at"?: string | null,"id"?: string,"inngest_event_id"?: string | null,"inngest_run_id"?: string | null,"interview_id"?: string | null,"progress"?: number,"repository_commit_sha"?: string | null,"stage"?: string | null,"started_at"?: string | null,"status"?: Database["public"]['Enums']["job_status"],"type": Database["public"]['Enums']["job_type"],"updated_at"?: string,"user_id": string,"workspace_id": string
                  }
                  Update: {
                    "created_at"?: string,"error_code"?: string | null,"error_message"?: string | null,"finished_at"?: string | null,"id"?: string,"inngest_event_id"?: string | null,"inngest_run_id"?: string | null,"interview_id"?: string | null,"progress"?: number,"repository_commit_sha"?: string | null,"stage"?: string | null,"started_at"?: string | null,"status"?: Database["public"]['Enums']["job_status"],"type"?: Database["public"]['Enums']["job_type"],"updated_at"?: string,"user_id"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "jobs_interview_id_workspace_id_user_id_fkey"
      columns: ["interview_id","workspace_id","user_id"]
isOneToOne: false
      referencedRelation: "interviews"
      referencedColumns: ["id","workspace_id","user_id"]
    },{
      foreignKeyName: "jobs_workspace_id_user_id_fkey"
      columns: ["workspace_id","user_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id","user_id"]
    }
                  ]
                },"profiles": {
                  Row: {
                    "avatar_url": string | null,"created_at": string,"display_name": string | null,"github_login": string | null,"id": string,"updated_at": string
                  }
                  Insert: {
                    "avatar_url"?: string | null,"created_at"?: string,"display_name"?: string | null,"github_login"?: string | null,"id": string,"updated_at"?: string
                  }
                  Update: {
                    "avatar_url"?: string | null,"created_at"?: string,"display_name"?: string | null,"github_login"?: string | null,"id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"reports": {
                  Row: {
                    "content": NonNullable<Json>,"created_at": string,"generated_at": string,"id": string,"interview_id": string,"storage_path": string | null,"updated_at": string,"user_id": string,"workspace_id": string
                  }
                  Insert: {
                    "content": NonNullable<Json>,"created_at"?: string,"generated_at"?: string,"id"?: string,"interview_id": string,"storage_path"?: string | null,"updated_at"?: string,"user_id": string,"workspace_id": string
                  }
                  Update: {
                    "content"?: NonNullable<Json>,"created_at"?: string,"generated_at"?: string,"id"?: string,"interview_id"?: string,"storage_path"?: string | null,"updated_at"?: string,"user_id"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "reports_interview_id_workspace_id_user_id_fkey"
      columns: ["interview_id","workspace_id","user_id"]
isOneToOne: false
      referencedRelation: "interviews"
      referencedColumns: ["id","workspace_id","user_id"]
    }
                  ]
                },"repositories": {
                  Row: {
                    "created_at": string,"default_branch": string,"full_name": string,"github_connection_id": string | null,"github_repo_id": number,"id": string,"is_private": boolean,"name": string,"owner": string,"updated_at": string,"user_id": string
                  }
                  Insert: {
                    "created_at"?: string,"default_branch": string,"full_name": string,"github_connection_id"?: string | null,"github_repo_id": number,"id"?: string,"is_private": boolean,"name": string,"owner": string,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"default_branch"?: string,"full_name"?: string,"github_connection_id"?: string | null,"github_repo_id"?: number,"id"?: string,"is_private"?: boolean,"name"?: string,"owner"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "repositories_github_connection_id_user_id_fkey"
      columns: ["github_connection_id","user_id"]
isOneToOne: false
      referencedRelation: "github_connections"
      referencedColumns: ["id","user_id"]
    },{
      foreignKeyName: "repositories_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"repository_memory": {
                  Row: {
                    "content": string,"created_at": string,"embedding": string | null,"id": string,"kind": string,"metadata": NonNullable<Json>,"repository_commit_sha": string,"repository_id": string,"structured": NonNullable<Json>,"token_count": number | null,"updated_at": string,"user_id": string,"workspace_id": string
                  }
                  Insert: {
                    "content": string,"created_at"?: string,"embedding"?: string | null,"id"?: string,"kind": string,"metadata"?: NonNullable<Json>,"repository_commit_sha": string,"repository_id": string,"structured"?: NonNullable<Json>,"token_count"?: number | null,"updated_at"?: string,"user_id": string,"workspace_id": string
                  }
                  Update: {
                    "content"?: string,"created_at"?: string,"embedding"?: string | null,"id"?: string,"kind"?: string,"metadata"?: NonNullable<Json>,"repository_commit_sha"?: string,"repository_id"?: string,"structured"?: NonNullable<Json>,"token_count"?: number | null,"updated_at"?: string,"user_id"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "repository_memory_workspace_id_repository_id_user_id_fkey"
      columns: ["workspace_id","repository_id","user_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id","repository_id","user_id"]
    }
                  ]
                },"workspaces": {
                  Row: {
                    "created_at": string,"id": string,"indexed_commit_sha": string | null,"ready_at": string | null,"repository_id": string,"status": Database["public"]['Enums']["workspace_status"],"target_commit_sha": string | null,"updated_at": string,"user_id": string
                  }
                  Insert: {
                    "created_at"?: string,"id"?: string,"indexed_commit_sha"?: string | null,"ready_at"?: string | null,"repository_id": string,"status"?: Database["public"]['Enums']["workspace_status"],"target_commit_sha"?: string | null,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"indexed_commit_sha"?: string | null,"ready_at"?: string | null,"repository_id"?: string,"status"?: Database["public"]['Enums']["workspace_status"],"target_commit_sha"?: string | null,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "workspaces_repository_id_user_id_fkey"
      columns: ["repository_id","user_id"]
isOneToOne: false
      referencedRelation: "repositories"
      referencedColumns: ["id","user_id"]
    },{
      foreignKeyName: "workspaces_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "complete_repository_analysis":
{ Args: { "p_commit_sha": string,"p_job_id": string,"p_memory": Json,"p_workspace_id": string }; Returns: boolean
                           },
"create_interview":
{ Args: { "p_coverage_map": Json,"p_plan": Json,"p_repository_commit_sha": string,"p_strategy": Json,"p_user_id": string,"p_workspace_id": string }; Returns: {
              "created_at": string,
"ended_at": string | null,
"id": string,
"integrity_warning_count": number,
"interview_number": number,
"last_active_at": string | null,
"repository_commit_sha": string,
"started_at": string | null,
"status": Database["public"]['Enums']["interview_status"],
"termination_detail": string | null,
"termination_reason": Database["public"]['Enums']["termination_reason"] | null,
"updated_at": string,
"user_id": string,
"workspace_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "interviews"
        isOneToOne: true
        isSetofReturn: false
      } },
"fail_repository_analysis":
{ Args: { "p_error_code": string,"p_error_message": string,"p_job_id": string,"p_workspace_id": string }; Returns: undefined
                           },
"match_repository_memory":
{ Args: { "p_commit_sha": string,"p_match_count"?: number,"p_query_embedding": string,"p_workspace_id": string }; Returns: {
              "content": string,"id": string,"kind": string,"metadata": Json,"similarity": number,"structured": Json
            }[]
                           },
"retry_repository_analysis":
{ Args: { "p_user_id": string,"p_workspace_id": string }; Returns: string
                           },
"update_interview_state":
{ Args: { "p_coverage_map": Json,"p_expected_version": number,"p_interview_id": string,"p_plan": Json,"p_strategy": Json }; Returns: number
                           }
          }
          Enums: {
            "event_type": "start"|"integrity_warning"|"pause"|"resume"|"termination"|"completion"|"evidence_examined","interview_status": "created"|"in_progress"|"paused"|"completed"|"terminated"|"failed","job_status": "queued"|"running"|"succeeded"|"failed","job_type": "repository_indexing"|"deep_analysis"|"report_generation","message_role": "ai"|"user"|"system","termination_reason": "integrity_violation"|"completed_early"|"time_limit"|"technical_failure"|"user_abandoned","workspace_status": "analyzing"|"ready"|"failed"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "public": {
          Enums: {
            "event_type": ["start", "integrity_warning", "pause", "resume", "termination", "completion", "evidence_examined"],"interview_status": ["created", "in_progress", "paused", "completed", "terminated", "failed"],"job_status": ["queued", "running", "succeeded", "failed"],"job_type": ["repository_indexing", "deep_analysis", "report_generation"],"message_role": ["ai", "user", "system"],"termination_reason": ["integrity_violation", "completed_early", "time_limit", "technical_failure", "user_abandoned"],"workspace_status": ["analyzing", "ready", "failed"]
          }
        }
} as const
