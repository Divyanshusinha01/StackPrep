export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      ai_usage: {
        Row: {
          audio_cached_input_tokens: number
          audio_input_tokens: number
          audio_output_tokens: number
          audio_seconds: number | null
          cached_input_tokens: number
          created_at: string
          estimated_cost_usd: number | null
          id: string
          idempotency_key: string | null
          input_tokens: number
          interview_id: string | null
          model: string
          output_tokens: number
          source: Database["public"]["Enums"]["ai_usage_source"]
          task: Database["public"]["Enums"]["ai_task"]
          user_id: string
          voice_segment_event_id: string | null
          workspace_id: string
        }
        Insert: {
          audio_cached_input_tokens?: number
          audio_input_tokens?: number
          audio_output_tokens?: number
          audio_seconds?: number | null
          cached_input_tokens?: number
          created_at?: string
          estimated_cost_usd?: number | null
          id?: string
          idempotency_key?: string | null
          input_tokens?: number
          interview_id?: string | null
          model: string
          output_tokens?: number
          source: Database["public"]["Enums"]["ai_usage_source"]
          task: Database["public"]["Enums"]["ai_task"]
          user_id: string
          voice_segment_event_id?: string | null
          workspace_id: string
        }
        Update: {
          audio_cached_input_tokens?: number
          audio_input_tokens?: number
          audio_output_tokens?: number
          audio_seconds?: number | null
          cached_input_tokens?: number
          created_at?: string
          estimated_cost_usd?: number | null
          id?: string
          idempotency_key?: string | null
          input_tokens?: number
          interview_id?: string | null
          model?: string
          output_tokens?: number
          source?: Database["public"]["Enums"]["ai_usage_source"]
          task?: Database["public"]["Enums"]["ai_task"]
          user_id?: string
          voice_segment_event_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_usage_interview_id_workspace_id_user_id_fkey"
            columns: ["interview_id", "workspace_id", "user_id"]
            isOneToOne: false
            referencedRelation: "interviews"
            referencedColumns: ["id", "workspace_id", "user_id"]
          },
          {
            foreignKeyName: "ai_usage_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_usage_voice_segment_event_id_interview_id_fkey"
            columns: ["voice_segment_event_id", "interview_id"]
            isOneToOne: false
            referencedRelation: "interview_events"
            referencedColumns: ["id", "interview_id"]
          },
          {
            foreignKeyName: "ai_usage_workspace_id_user_id_fkey"
            columns: ["workspace_id", "user_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      code_calls: {
        Row: {
          callee_name: string
          callee_text: string
          caller_ord: number | null
          col: number
          file_id: string
          id: number
          line: number
          ord: number
          repository_commit_sha: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          callee_name?: never
          callee_text: string
          caller_ord?: number | null
          col: number
          file_id: string
          id?: never
          line: number
          ord: number
          repository_commit_sha: string
          user_id: string
          workspace_id: string
        }
        Update: {
          callee_name?: never
          callee_text?: string
          caller_ord?: number | null
          col?: number
          file_id?: string
          id?: never
          line?: number
          ord?: number
          repository_commit_sha?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "code_calls_file_id_caller_ord_fkey"
            columns: ["file_id", "caller_ord"]
            isOneToOne: false
            referencedRelation: "code_symbols"
            referencedColumns: ["file_id", "ord"]
          },
          {
            foreignKeyName: "code_calls_file_id_workspace_id_repository_commit_sha_user_fkey"
            columns: ["file_id", "workspace_id", "repository_commit_sha", "user_id"]
            isOneToOne: false
            referencedRelation: "code_files"
            referencedColumns: ["id", "workspace_id", "repository_commit_sha", "user_id"]
          },
        ]
      }
      code_files: {
        Row: {
          blob_sha: string
          created_at: string
          facts_hash: string
          id: string
          language: string | null
          line_count: number | null
          parse_error_count: number
          parse_status: string
          parser_version: string
          path: string
          repository_commit_sha: string
          repository_id: string
          size_bytes: number
          skipped_reason: string | null
          stats: Json
          user_id: string
          workspace_id: string
        }
        Insert: {
          blob_sha: string
          created_at?: string
          facts_hash: string
          id?: string
          language?: string | null
          line_count?: number | null
          parse_error_count?: number
          parse_status: string
          parser_version: string
          path: string
          repository_commit_sha: string
          repository_id: string
          size_bytes: number
          skipped_reason?: string | null
          stats?: Json
          user_id: string
          workspace_id: string
        }
        Update: {
          blob_sha?: string
          created_at?: string
          facts_hash?: string
          id?: string
          language?: string | null
          line_count?: number | null
          parse_error_count?: number
          parse_status?: string
          parser_version?: string
          path?: string
          repository_commit_sha?: string
          repository_id?: string
          size_bytes?: number
          skipped_reason?: string | null
          stats?: Json
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "code_files_workspace_id_repository_id_user_id_fkey"
            columns: ["workspace_id", "repository_id", "user_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id", "repository_id", "user_id"]
          },
        ]
      }
      code_imports: {
        Row: {
          file_id: string
          id: number
          kind: string
          line: number
          names: string[]
          ord: number
          repository_commit_sha: string
          resolved_path: string | null
          source: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          file_id: string
          id?: never
          kind: string
          line: number
          names?: string[]
          ord: number
          repository_commit_sha: string
          resolved_path?: string | null
          source: string
          user_id: string
          workspace_id: string
        }
        Update: {
          file_id?: string
          id?: never
          kind?: string
          line?: number
          names?: string[]
          ord?: number
          repository_commit_sha?: string
          resolved_path?: string | null
          source?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "code_imports_file_id_workspace_id_repository_commit_sha_us_fkey"
            columns: ["file_id", "workspace_id", "repository_commit_sha", "user_id"]
            isOneToOne: false
            referencedRelation: "code_files"
            referencedColumns: ["id", "workspace_id", "repository_commit_sha", "user_id"]
          },
        ]
      }
      code_symbols: {
        Row: {
          end_col: number
          end_line: number
          exported: boolean
          file_id: string
          id: number
          kind: string
          name: string
          ord: number
          parent_ord: number | null
          repository_commit_sha: string
          signature: string | null
          start_col: number
          start_line: number
          user_id: string
          workspace_id: string
        }
        Insert: {
          end_col: number
          end_line: number
          exported?: boolean
          file_id: string
          id?: never
          kind: string
          name: string
          ord: number
          parent_ord?: number | null
          repository_commit_sha: string
          signature?: string | null
          start_col: number
          start_line: number
          user_id: string
          workspace_id: string
        }
        Update: {
          end_col?: number
          end_line?: number
          exported?: boolean
          file_id?: string
          id?: never
          kind?: string
          name?: string
          ord?: number
          parent_ord?: number | null
          repository_commit_sha?: string
          signature?: string | null
          start_col?: number
          start_line?: number
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "code_symbols_file_id_parent_ord_fkey"
            columns: ["file_id", "parent_ord"]
            isOneToOne: false
            referencedRelation: "code_symbols"
            referencedColumns: ["file_id", "ord"]
          },
          {
            foreignKeyName: "code_symbols_file_id_workspace_id_repository_commit_sha_us_fkey"
            columns: ["file_id", "workspace_id", "repository_commit_sha", "user_id"]
            isOneToOne: false
            referencedRelation: "code_files"
            referencedColumns: ["id", "workspace_id", "repository_commit_sha", "user_id"]
          },
        ]
      }
      evaluations: {
        Row: {
          category: string
          created_at: string
          discrepancy: boolean
          discrepancy_detail: string | null
          gaps: Json
          id: string
          interview_id: string
          message_id: string
          rating: string | null
          repo_evidence: Json
          score: number | null
          strengths: Json
          user_id: string
        }
        Insert: {
          category: string
          created_at?: string
          discrepancy?: boolean
          discrepancy_detail?: string | null
          gaps?: Json
          id?: string
          interview_id: string
          message_id: string
          rating?: string | null
          repo_evidence?: Json
          score?: number | null
          strengths?: Json
          user_id: string
        }
        Update: {
          category?: string
          created_at?: string
          discrepancy?: boolean
          discrepancy_detail?: string | null
          gaps?: Json
          id?: string
          interview_id?: string
          message_id?: string
          rating?: string | null
          repo_evidence?: Json
          score?: number | null
          strengths?: Json
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "evaluations_interview_id_user_id_fkey"
            columns: ["interview_id", "user_id"]
            isOneToOne: false
            referencedRelation: "interviews"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "evaluations_message_id_interview_id_fkey"
            columns: ["message_id", "interview_id"]
            isOneToOne: false
            referencedRelation: "interview_messages"
            referencedColumns: ["id", "interview_id"]
          },
        ]
      }
      github_connections: {
        Row: {
          account_login: string
          account_type: string | null
          created_at: string
          github_user_id: number
          id: string
          installation_id: number
          permissions: Json
          repository_selection: string | null
          suspended_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          account_login: string
          account_type?: string | null
          created_at?: string
          github_user_id: number
          id?: string
          installation_id: number
          permissions?: Json
          repository_selection?: string | null
          suspended_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          account_login?: string
          account_type?: string | null
          created_at?: string
          github_user_id?: number
          id?: string
          installation_id?: number
          permissions?: Json
          repository_selection?: string | null
          suspended_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "github_connections_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      interview_events: {
        Row: {
          client_event_id: string | null
          created_at: string
          event_type: Database["public"]["Enums"]["event_type"]
          id: string
          interview_id: string
          occurred_at: string
          payload: Json
          sequence: number
          user_id: string
        }
        Insert: {
          client_event_id?: string | null
          created_at?: string
          event_type: Database["public"]["Enums"]["event_type"]
          id?: string
          interview_id: string
          occurred_at?: string
          payload?: Json
          sequence: number
          user_id: string
        }
        Update: {
          client_event_id?: string | null
          created_at?: string
          event_type?: Database["public"]["Enums"]["event_type"]
          id?: string
          interview_id?: string
          occurred_at?: string
          payload?: Json
          sequence?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "interview_events_interview_id_user_id_fkey"
            columns: ["interview_id", "user_id"]
            isOneToOne: false
            referencedRelation: "interviews"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      interview_messages: {
        Row: {
          client_event_id: string
          content: string
          created_at: string
          id: string
          interview_id: string
          metadata: Json
          question_message_id: string | null
          role: Database["public"]["Enums"]["message_role"]
          sequence: number
          user_id: string
        }
        Insert: {
          client_event_id?: string
          content: string
          created_at?: string
          id?: string
          interview_id: string
          metadata?: Json
          question_message_id?: string | null
          role: Database["public"]["Enums"]["message_role"]
          sequence: number
          user_id: string
        }
        Update: {
          client_event_id?: string
          content?: string
          created_at?: string
          id?: string
          interview_id?: string
          metadata?: Json
          question_message_id?: string | null
          role?: Database["public"]["Enums"]["message_role"]
          sequence?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "interview_messages_interview_id_user_id_fkey"
            columns: ["interview_id", "user_id"]
            isOneToOne: false
            referencedRelation: "interviews"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "interview_messages_question_message_id_interview_id_fkey"
            columns: ["question_message_id", "interview_id"]
            isOneToOne: false
            referencedRelation: "interview_messages"
            referencedColumns: ["id", "interview_id"]
          },
        ]
      }
      interview_state: {
        Row: {
          coverage_map: Json
          created_at: string
          interview_id: string
          plan: Json
          strategy: Json
          updated_at: string
          version: number
        }
        Insert: {
          coverage_map?: Json
          created_at?: string
          interview_id: string
          plan?: Json
          strategy?: Json
          updated_at?: string
          version?: number
        }
        Update: {
          coverage_map?: Json
          created_at?: string
          interview_id?: string
          plan?: Json
          strategy?: Json
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "interview_state_interview_id_fkey"
            columns: ["interview_id"]
            isOneToOne: true
            referencedRelation: "interviews"
            referencedColumns: ["id"]
          },
        ]
      }
      interviews: {
        Row: {
          created_at: string
          ended_at: string | null
          id: string
          integrity_warning_count: number
          interview_number: number
          last_active_at: string | null
          pause_count: number
          paused_at: string | null
          repository_commit_sha: string
          started_at: string | null
          status: Database["public"]["Enums"]["interview_status"]
          termination_detail: string | null
          termination_reason:
            | Database["public"]["Enums"]["termination_reason"]
            | null
          updated_at: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          ended_at?: string | null
          id?: string
          integrity_warning_count?: number
          interview_number: number
          last_active_at?: string | null
          pause_count?: number
          paused_at?: string | null
          repository_commit_sha: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["interview_status"]
          termination_detail?: string | null
          termination_reason?:
            | Database["public"]["Enums"]["termination_reason"]
            | null
          updated_at?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          ended_at?: string | null
          id?: string
          integrity_warning_count?: number
          interview_number?: number
          last_active_at?: string | null
          pause_count?: number
          paused_at?: string | null
          repository_commit_sha?: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["interview_status"]
          termination_detail?: string | null
          termination_reason?:
            | Database["public"]["Enums"]["termination_reason"]
            | null
          updated_at?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "interviews_workspace_id_user_id_fkey"
            columns: ["workspace_id", "user_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      jobs: {
        Row: {
          created_at: string
          error_code: string | null
          error_message: string | null
          finished_at: string | null
          id: string
          inngest_event_id: string | null
          inngest_run_id: string | null
          interview_id: string | null
          progress: number
          repository_commit_sha: string | null
          stage: string | null
          started_at: string | null
          status: Database["public"]["Enums"]["job_status"]
          type: Database["public"]["Enums"]["job_type"]
          updated_at: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          finished_at?: string | null
          id?: string
          inngest_event_id?: string | null
          inngest_run_id?: string | null
          interview_id?: string | null
          progress?: number
          repository_commit_sha?: string | null
          stage?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["job_status"]
          type: Database["public"]["Enums"]["job_type"]
          updated_at?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          finished_at?: string | null
          id?: string
          inngest_event_id?: string | null
          inngest_run_id?: string | null
          interview_id?: string | null
          progress?: number
          repository_commit_sha?: string | null
          stage?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["job_status"]
          type?: Database["public"]["Enums"]["job_type"]
          updated_at?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "jobs_interview_id_workspace_id_user_id_fkey"
            columns: ["interview_id", "workspace_id", "user_id"]
            isOneToOne: false
            referencedRelation: "interviews"
            referencedColumns: ["id", "workspace_id", "user_id"]
          },
          {
            foreignKeyName: "jobs_workspace_id_user_id_fkey"
            columns: ["workspace_id", "user_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string | null
          github_login: string | null
          id: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          github_login?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          github_login?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      reports: {
        Row: {
          content: Json
          created_at: string
          generated_at: string
          id: string
          interview_id: string
          storage_path: string | null
          updated_at: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          content: Json
          created_at?: string
          generated_at?: string
          id?: string
          interview_id: string
          storage_path?: string | null
          updated_at?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          content?: Json
          created_at?: string
          generated_at?: string
          id?: string
          interview_id?: string
          storage_path?: string | null
          updated_at?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "reports_interview_id_workspace_id_user_id_fkey"
            columns: ["interview_id", "workspace_id", "user_id"]
            isOneToOne: false
            referencedRelation: "interviews"
            referencedColumns: ["id", "workspace_id", "user_id"]
          },
        ]
      }
      repositories: {
        Row: {
          created_at: string
          default_branch: string
          full_name: string
          github_connection_id: string | null
          github_repo_id: number
          id: string
          is_private: boolean
          name: string
          owner: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          default_branch: string
          full_name: string
          github_connection_id?: string | null
          github_repo_id: number
          id?: string
          is_private: boolean
          name: string
          owner: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          default_branch?: string
          full_name?: string
          github_connection_id?: string | null
          github_repo_id?: number
          id?: string
          is_private?: boolean
          name?: string
          owner?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "repositories_github_connection_id_user_id_fkey"
            columns: ["github_connection_id", "user_id"]
            isOneToOne: false
            referencedRelation: "github_connections"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "repositories_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      repository_memory: {
        Row: {
          content: string
          created_at: string
          embedding: string | null
          id: string
          kind: string
          metadata: Json
          repository_commit_sha: string
          repository_id: string
          structured: Json
          token_count: number | null
          updated_at: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          content: string
          created_at?: string
          embedding?: string | null
          id?: string
          kind: string
          metadata?: Json
          repository_commit_sha: string
          repository_id: string
          structured?: Json
          token_count?: number | null
          updated_at?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          content?: string
          created_at?: string
          embedding?: string | null
          id?: string
          kind?: string
          metadata?: Json
          repository_commit_sha?: string
          repository_id?: string
          structured?: Json
          token_count?: number | null
          updated_at?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "repository_memory_workspace_id_repository_id_user_id_fkey"
            columns: ["workspace_id", "repository_id", "user_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id", "repository_id", "user_id"]
          },
        ]
      }
      workspaces: {
        Row: {
          created_at: string
          id: string
          indexed_commit_sha: string | null
          ready_at: string | null
          repository_id: string
          status: Database["public"]["Enums"]["workspace_status"]
          target_commit_sha: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          indexed_commit_sha?: string | null
          ready_at?: string | null
          repository_id: string
          status?: Database["public"]["Enums"]["workspace_status"]
          target_commit_sha?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          indexed_commit_sha?: string | null
          ready_at?: string | null
          repository_id?: string
          status?: Database["public"]["Enums"]["workspace_status"]
          target_commit_sha?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspaces_repository_id_user_id_fkey"
            columns: ["repository_id", "user_id"]
            isOneToOne: false
            referencedRelation: "repositories"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "workspaces_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      ai_usage_effective: {
        Row: {
          audio_cached_input_tokens: number | null
          audio_input_tokens: number | null
          audio_output_tokens: number | null
          audio_seconds: number | null
          cached_input_tokens: number | null
          created_at: string | null
          estimated_cost_usd: number | null
          id: string | null
          input_tokens: number | null
          interview_id: string | null
          is_estimate: boolean | null
          model: string | null
          output_tokens: number | null
          source: Database["public"]["Enums"]["ai_usage_source"] | null
          task: Database["public"]["Enums"]["ai_task"] | null
          user_id: string | null
          voice_segment_event_id: string | null
          workspace_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_usage_interview_id_workspace_id_user_id_fkey"
            columns: ["interview_id", "workspace_id", "user_id"]
            isOneToOne: false
            referencedRelation: "interviews"
            referencedColumns: ["id", "workspace_id", "user_id"]
          },
          {
            foreignKeyName: "ai_usage_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_usage_voice_segment_event_id_interview_id_fkey"
            columns: ["voice_segment_event_id", "interview_id"]
            isOneToOne: false
            referencedRelation: "interview_events"
            referencedColumns: ["id", "interview_id"]
          },
          {
            foreignKeyName: "ai_usage_workspace_id_user_id_fkey"
            columns: ["workspace_id", "user_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
    }
    Functions: {
      complete_code_index: {
        Args: {
          p_commit_sha: string
          p_job_id: string
          p_parser_version: string
          p_summary: Json
          p_workspace_id: string
        }
        Returns: undefined
      }
      complete_interview: {
        Args: {
          p_interview_id: string
          p_reason: Database["public"]["Enums"]["termination_reason"]
          p_user_id: string
        }
        Returns: boolean
      }
      complete_repository_analysis: {
        Args: {
          p_commit_sha: string
          p_job_id: string
          p_memory: Json
          p_workspace_id: string
        }
        Returns: boolean
      }
      create_interview: {
        Args: {
          p_coverage_map: Json
          p_plan: Json
          p_repository_commit_sha: string
          p_strategy: Json
          p_user_id: string
          p_workspace_id: string
        }
        Returns: {
          created_at: string
          ended_at: string | null
          id: string
          integrity_warning_count: number
          interview_number: number
          last_active_at: string | null
          pause_count: number
          paused_at: string | null
          repository_commit_sha: string
          started_at: string | null
          status: Database["public"]["Enums"]["interview_status"]
          termination_detail: string | null
          termination_reason:
            | Database["public"]["Enums"]["termination_reason"]
            | null
          updated_at: string
          user_id: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "interviews"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      end_interview_by_user: {
        Args: { p_interview_id: string; p_user_id: string }
        Returns: {
          disconnected_sequence: number
          status: string
        }[]
      }
      fail_code_index: {
        Args: {
          p_error_code: string
          p_error_message: string
          p_job_id: string
          p_workspace_id: string
        }
        Returns: undefined
      }
      fail_deep_analysis: {
        Args: {
          p_error_code: string
          p_error_message: string
          p_job_id: string
          p_workspace_id: string
        }
        Returns: undefined
      }
      fail_repository_analysis: {
        Args: {
          p_error_code: string
          p_error_message: string
          p_job_id: string
          p_workspace_id: string
        }
        Returns: undefined
      }
      find_callers: {
        Args: {
          p_commit_sha: string
          p_limit?: number
          p_name: string
          p_workspace_id: string
        }
        Returns: {
          callee_text: string
          caller_kind: string
          caller_name: string
          col: number
          exact: boolean
          line: number
          path: string
        }[]
      }
      find_dependencies: {
        Args: {
          p_commit_sha: string
          p_limit?: number
          p_path: string
          p_workspace_id: string
        }
        Returns: {
          kind: string
          line: number
          names: string[]
          resolved_path: string
          source: string
        }[]
      }
      find_importers: {
        Args: {
          p_commit_sha: string
          p_limit?: number
          p_target: string
          p_workspace_id: string
        }
        Returns: {
          kind: string
          line: number
          names: string[]
          path: string
          resolved_path: string
          source: string
        }[]
      }
      find_symbol: {
        Args: {
          p_commit_sha: string
          p_kind?: string
          p_limit?: number
          p_name: string
          p_workspace_id: string
        }
        Returns: {
          end_col: number
          end_line: number
          exact: boolean
          exported: boolean
          kind: string
          language: string
          name: string
          parent_name: string
          path: string
          signature: string
          start_col: number
          start_line: number
        }[]
      }
      match_repository_memory: {
        Args: {
          p_commit_sha: string
          p_match_count?: number
          p_query_embedding: string
          p_workspace_id: string
        }
        Returns: {
          content: string
          id: string
          kind: string
          metadata: Json
          similarity: number
          structured: Json
        }[]
      }
      prune_code_index: {
        Args: { p_keep_commits: string[]; p_workspace_id: string }
        Returns: number
      }
      record_evidence_examined: {
        Args: { p_evidence: Json; p_interview_id: string; p_user_id: string }
        Returns: number
      }
      record_integrity_signal: {
        Args: {
          p_check_id: string
          p_interview_id: string
          p_kind: string
          p_user_id: string
        }
        Returns: {
          status: string
          warning_number: number
        }[]
      }
      record_tool_call: {
        Args: {
          p_args: Json
          p_call_id: string
          p_evaluation: Json
          p_evidence: Json
          p_interview_id: string
          p_result: Json
          p_result_summary: Json
          p_tool: string
          p_user_id: string
        }
        Returns: {
          result: Json
          sequence: number
          status: string
        }[]
      }
      pause_interview: {
        Args: { p_interview_id: string; p_user_id: string }
        Returns: {
          disconnected_sequence: number
          pause_count: number
          paused_at: string
          status: string
        }[]
      }
      record_transcript_turn: {
        Args: {
          p_client_event_id: string
          p_content: string
          p_interview_id: string
          p_metadata: Json
          p_role: Database["public"]["Enums"]["message_role"]
          p_user_id: string
        }
        Returns: {
          sequence: number
          status: string
        }[]
      }
      record_voice_event: {
        Args: {
          p_client_event_id: string
          p_event_type: Database["public"]["Enums"]["event_type"]
          p_interview_id: string
          p_payload: Json
          p_user_id: string
        }
        Returns: {
          sequence: number
          status: string
        }[]
      }
      replace_code_index: {
        Args: {
          p_commit_sha: string
          p_files: Json
          p_parser_version: string
          p_workspace_id: string
        }
        Returns: number
      }
      request_code_index: {
        Args: {
          p_commit_sha: string
          p_parser_version: string
          p_workspace_id: string
        }
        Returns: string
      }
      request_deep_analysis: {
        Args: { p_commit_sha: string; p_workspace_id: string }
        Returns: string
      }
      request_report: {
        Args: { p_interview_id: string; p_user_id: string }
        Returns: string
      }
      reserve_integrity_check: {
        Args: { p_interview_id: string; p_user_id: string }
        Returns: {
          check_id: string
          status: string
        }[]
      }
      resume_interview: {
        Args: { p_interview_id: string; p_user_id: string }
        Returns: {
          status: string
        }[]
      }
      retry_repository_analysis: {
        Args: { p_user_id: string; p_workspace_id: string }
        Returns: string
      }
      save_code_memory: {
        Args: {
          p_commit_sha: string
          p_job_id: string
          p_rows: Json
          p_workspace_id: string
        }
        Returns: number
      }
      save_deep_analysis: {
        Args: {
          p_commit_sha: string
          p_job_id: string
          p_payload: Json
          p_workspace_id: string
        }
        Returns: undefined
      }
      save_report: {
        Args: { p_content: Json; p_interview_id: string; p_job_id: string }
        Returns: undefined
      }
      search_code_symbols: {
        Args: {
          p_commit_sha: string
          p_limit?: number
          p_terms: string[]
          p_workspace_id: string
        }
        Returns: {
          end_line: number
          exported: boolean
          kind: string
          language: string
          matched_terms: number
          name: string
          parent_name: string
          path: string
          signature: string
          start_line: number
        }[]
      }
      start_interview: {
        Args: {
          p_commit_sha: string
          p_user_id: string
          p_workspace_id: string
        }
        Returns: {
          created_at: string
          interview_id: string
          interview_number: number
          job_id: string
          status: Database["public"]["Enums"]["interview_status"]
        }[]
      }
      update_interview_state: {
        Args: {
          p_coverage_map: Json
          p_expected_version: number
          p_interview_id: string
          p_plan: Json
          p_strategy: Json
        }
        Returns: number
      }
    }
    Enums: {
      ai_task:
        | "voice"
        | "auxiliary"
        | "deep_analysis"
        | "planning"
        | "evaluation"
        | "report"
        | "vision"
        | "embedding"
      ai_usage_source: "provider" | "client_reported" | "duration_estimate"
      event_type:
        | "start"
        | "integrity_warning"
        | "pause"
        | "resume"
        | "termination"
        | "completion"
        | "evidence_examined"
        | "tool_call"
        | "connected"
        | "disconnected"
        | "integrity_check"
      interview_status:
        | "created"
        | "in_progress"
        | "paused"
        | "completed"
        | "terminated"
        | "failed"
      job_status: "queued" | "running" | "succeeded" | "failed"
      job_type:
        | "repository_indexing"
        | "deep_analysis"
        | "report_generation"
        | "interview_planning"
        | "code_indexing"
      message_role: "ai" | "user" | "system"
      termination_reason:
        | "integrity_violation"
        | "completed_early"
        | "time_limit"
        | "technical_failure"
        | "user_abandoned"
        | "user_ended"
      workspace_status: "analyzing" | "ready" | "failed"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      ai_task: [
        "voice",
        "auxiliary",
        "deep_analysis",
        "planning",
        "evaluation",
        "report",
        "vision",
        "embedding",
      ],
      ai_usage_source: ["provider", "client_reported", "duration_estimate"],
      event_type: [
        "start",
        "integrity_warning",
        "pause",
        "resume",
        "termination",
        "completion",
        "evidence_examined",
        "tool_call",
        "connected",
        "disconnected",
        "integrity_check",
      ],
      interview_status: [
        "created",
        "in_progress",
        "paused",
        "completed",
        "terminated",
        "failed",
      ],
      job_status: ["queued", "running", "succeeded", "failed"],
      job_type: [
        "repository_indexing",
        "deep_analysis",
        "report_generation",
        "interview_planning",
        "code_indexing",
      ],
      message_role: ["ai", "user", "system"],
      termination_reason: [
        "integrity_violation",
        "completed_early",
        "time_limit",
        "technical_failure",
        "user_abandoned",
        "user_ended",
      ],
      workspace_status: ["analyzing", "ready", "failed"],
    },
  },
} as const
