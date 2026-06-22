import { z } from 'zod';

// pydantic-parity: lax boolean->number coercion at the LLM-facing boundary.
// bu-2-0 occasionally emits booleans for integer fields (token-level confusion);
// python upstream accepts this silently via pydantic's default lax mode.
// Without this, every action that expects a numeric index hard-rejects and the
// agent loops to max_failures. See: https://docs.pydantic.dev/latest/concepts/strict_mode/
export const lenientInt = (min?: number) => {
  let schema = z.number().int();
  if (min !== undefined) schema = schema.min(min);
  return z.preprocess(
    (v) => (typeof v === 'boolean' ? Number(v) : v),
    schema,
  );
};

export const lenientNumber = () =>
  z.preprocess(
    (v) => (typeof v === 'boolean' ? Number(v) : v),
    z.number(),
  );

export const SearchGoogleActionSchema = z.object({
  query: z.string(),
});
export type SearchGoogleAction = z.infer<typeof SearchGoogleActionSchema>;

export const SearchActionSchema = z.object({
  query: z.string(),
  engine: z.string().default('duckduckgo'),
});
export type SearchAction = z.infer<typeof SearchActionSchema>;

export const GoToUrlActionSchema = z.object({
  url: z.string(),
  new_tab: z.boolean().default(false),
});
export type GoToUrlAction = z.infer<typeof GoToUrlActionSchema>;

export const WaitActionSchema = z.object({
  seconds: z.number().default(3),
});
export type WaitAction = z.infer<typeof WaitActionSchema>;

export const ClickElementActionSchema = z.object({
  index: lenientInt(1).optional(),
  coordinate_x: z.number().int().optional(),
  coordinate_y: z.number().int().optional(),
});
export type ClickElementAction = z.infer<typeof ClickElementActionSchema>;

export const ClickElementActionIndexOnlySchema = z.object({
  index: lenientInt(1),
});
export type ClickElementActionIndexOnly = z.infer<
  typeof ClickElementActionIndexOnlySchema
>;

export const InputTextActionSchema = z.object({
  index: lenientInt(0),
  text: z.string(),
  clear: z.boolean().default(true),
});
export type InputTextAction = z.infer<typeof InputTextActionSchema>;

export const DoneActionSchema = z.object({
  text: z.string(),
  success: z.boolean().default(true),
  files_to_display: z.array(z.string()).default([]),
});
export type DoneAction = z.infer<typeof DoneActionSchema>;

export const StructuredOutputActionSchema = <T extends z.ZodTypeAny>(
  dataSchema: T
) =>
  z.object({
    success: z
      .boolean()
      .default(true)
      .describe('True if user_request completed successfully'),
    data: dataSchema,
  });
export type StructuredOutputAction<T> = {
  success: boolean;
  data: T;
};

const TabIdentifierActionSchema = z
  .object({
    page_id: z.number().int().optional(),
    tab_id: z.string().trim().length(4).optional(),
  })
  .refine((value) => value.page_id != null || value.tab_id != null, {
    message: 'Provide tab_id or page_id',
  });

export const SwitchTabActionSchema = TabIdentifierActionSchema;
export type SwitchTabAction = z.infer<typeof SwitchTabActionSchema>;

export const CloseTabActionSchema = TabIdentifierActionSchema;
export type CloseTabAction = z.infer<typeof CloseTabActionSchema>;

export const ScrollActionSchema = z.object({
  down: z.boolean().default(true), // Default to scroll down
  num_pages: lenientNumber().default(1), // Default to 1 page
  pages: lenientNumber().optional(), // Alias for num_pages
  index: lenientInt().optional(),
});
export type ScrollAction = z.infer<typeof ScrollActionSchema>;

export const SendKeysActionSchema = z.object({
  keys: z.string(),
});
export type SendKeysAction = z.infer<typeof SendKeysActionSchema>;

export const UploadFileActionSchema = z.object({
  index: lenientInt(),
  path: z.string(),
});
export type UploadFileAction = z.infer<typeof UploadFileActionSchema>;

export const ScreenshotActionSchema = z.object({
  file_name: z.string().optional(),
});
export type ScreenshotAction = z.infer<typeof ScreenshotActionSchema>;

export const SaveAsPdfActionSchema = z.object({
  file_name: z.string().optional(),
  print_background: z.boolean().default(true),
  landscape: z.boolean().default(false),
  scale: z.number().min(0.1).max(2.0).default(1.0),
  paper_format: z.string().default('Letter'),
});
export type SaveAsPdfAction = z.infer<typeof SaveAsPdfActionSchema>;

export const EvaluateActionSchema = z.object({
  code: z.string(),
});
export type EvaluateAction = z.infer<typeof EvaluateActionSchema>;

export const ExtractPageContentActionSchema = z.object({
  value: z.string(),
});
export type ExtractPageContentAction = z.infer<
  typeof ExtractPageContentActionSchema
>;

export const ExtractStructuredDataActionSchema = z.object({
  query: z.string(),
  extract_links: z.boolean().default(false),
  start_from_char: z.number().int().default(0),
  output_schema: z.record(z.string(), z.unknown()).nullable().optional(),
  already_collected: z.array(z.string()).default([]),
});
export type ExtractStructuredDataAction = z.infer<
  typeof ExtractStructuredDataActionSchema
>;

export const SearchPageActionSchema = z.object({
  pattern: z.string(),
  regex: z.boolean().default(false),
  case_sensitive: z.boolean().default(false),
  context_chars: z.number().int().default(150),
  css_scope: z.string().optional(),
  max_results: z.number().int().default(25),
});
export type SearchPageAction = z.infer<typeof SearchPageActionSchema>;

export const FindElementsActionSchema = z.object({
  selector: z.string(),
  attributes: z.array(z.string()).optional(),
  max_results: z.number().int().default(50),
  include_text: z.boolean().default(true),
});
export type FindElementsAction = z.infer<typeof FindElementsActionSchema>;

export const ReadFileActionSchema = z.object({
  file_name: z.string(),
});
export type ReadFileAction = z.infer<typeof ReadFileActionSchema>;

export const WriteFileActionSchema = z.object({
  file_name: z.string(),
  content: z.string(),
  append: z.boolean().optional(),
  trailing_newline: z.boolean().optional(),
  leading_newline: z.boolean().optional(),
});
export type WriteFileAction = z.infer<typeof WriteFileActionSchema>;

export const ReplaceFileStrActionSchema = z.object({
  file_name: z.string(),
  old_str: z.string(),
  new_str: z.string(),
});
export type ReplaceFileStrAction = z.infer<typeof ReplaceFileStrActionSchema>;

export const ScrollToTextActionSchema = z.object({
  text: z.string(),
});
export type ScrollToTextAction = z.infer<typeof ScrollToTextActionSchema>;

export const DropdownOptionsActionSchema = z.object({
  index: lenientInt(1),
});
export type DropdownOptionsAction = z.infer<typeof DropdownOptionsActionSchema>;

export const SelectDropdownActionSchema = z.object({
  index: lenientInt(1),
  text: z.string(),
});
export type SelectDropdownAction = z.infer<typeof SelectDropdownActionSchema>;

export const SheetsRangeActionSchema = z.object({
  cell_or_range: z.string(),
});
export type SheetsRangeAction = z.infer<typeof SheetsRangeActionSchema>;

export const SheetsUpdateActionSchema = z.object({
  cell_or_range: z.string(),
  value: z.string(),
});
export type SheetsUpdateAction = z.infer<typeof SheetsUpdateActionSchema>;

export const SheetsInputActionSchema = z.object({
  text: z.string(),
});
export type SheetsInputAction = z.infer<typeof SheetsInputActionSchema>;

export const NoParamsActionSchema = z
  .object({
    description: z.string().optional(),
  })
  .passthrough();
export type NoParamsAction = z.infer<typeof NoParamsActionSchema>;
