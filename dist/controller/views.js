import { z } from 'zod';
// pydantic-parity: lax boolean->number coercion at the LLM-facing boundary.
// bu-2-0 occasionally emits booleans for integer fields (token-level confusion);
// python upstream accepts this silently via pydantic's default lax mode.
// Without this, every action that expects a numeric index hard-rejects and the
// agent loops to max_failures. See: https://docs.pydantic.dev/latest/concepts/strict_mode/
export const lenientInt = (min) => {
    let schema = z.number().int();
    if (min !== undefined)
        schema = schema.min(min);
    return z.preprocess((v) => (typeof v === 'boolean' ? Number(v) : v), schema);
};
export const lenientNumber = () => z.preprocess((v) => (typeof v === 'boolean' ? Number(v) : v), z.number());
// pydantic-parity: coerce missing/null booleans to a default at the LLM-facing
// boundary. bu-2-0 occasionally omits required boolean fields entirely
// (e.g. simple-judge `is_correct` returns `undefined`); python upstream
// silently defaults via pydantic. Without this, the structured-output parse
// throws and the judge step is skipped (or worse, retried until budget is
// exhausted). String coercion handles the "true"/"false" shape too.
export const lenientBool = (defaultValue = false) => z.preprocess((v) => {
    if (v === undefined || v === null)
        return defaultValue;
    if (typeof v === 'string') {
        const lower = v.trim().toLowerCase();
        if (lower === 'true')
            return true;
        if (lower === 'false')
            return false;
    }
    return v;
}, z.boolean());
export const SearchGoogleActionSchema = z.object({
    query: z.string(),
});
export const SearchActionSchema = z.object({
    query: z.string(),
    engine: z.string().default('duckduckgo'),
});
export const GoToUrlActionSchema = z.object({
    url: z.string(),
    new_tab: z.boolean().default(false),
});
export const WaitActionSchema = z.object({
    seconds: z.number().default(3),
});
export const ClickElementActionSchema = z.object({
    index: lenientInt(0).optional(),
    coordinate_x: z.number().int().optional(),
    coordinate_y: z.number().int().optional(),
});
export const ClickElementActionIndexOnlySchema = z.object({
    index: lenientInt(0),
});
export const InputTextActionSchema = z.object({
    index: lenientInt(0),
    text: z.string(),
    clear: z.boolean().default(true),
});
export const DoneActionSchema = z.object({
    text: z.string(),
    success: z.boolean().default(true),
    files_to_display: z.array(z.string()).default([]),
});
export const StructuredOutputActionSchema = (dataSchema) => z.object({
    success: z
        .boolean()
        .default(true)
        .describe('True if user_request completed successfully'),
    data: dataSchema,
});
const TabIdentifierActionSchema = z
    .object({
    page_id: z.number().int().optional(),
    tab_id: z.string().trim().length(4).optional(),
})
    .refine((value) => value.page_id != null || value.tab_id != null, {
    message: 'Provide tab_id or page_id',
});
export const SwitchTabActionSchema = TabIdentifierActionSchema;
export const CloseTabActionSchema = TabIdentifierActionSchema;
export const ScrollActionSchema = z.object({
    down: z.boolean().default(true), // Default to scroll down
    num_pages: lenientNumber().default(1), // Default to 1 page
    pages: lenientNumber().optional(), // Alias for num_pages
    index: lenientInt().optional(),
});
export const SendKeysActionSchema = z.object({
    keys: z.string(),
});
export const UploadFileActionSchema = z.object({
    index: lenientInt(),
    path: z.string(),
});
export const ScreenshotActionSchema = z.object({
    file_name: z.string().optional(),
});
export const SaveAsPdfActionSchema = z.object({
    file_name: z.string().optional(),
    print_background: z.boolean().default(true),
    landscape: z.boolean().default(false),
    scale: z.number().min(0.1).max(2.0).default(1.0),
    paper_format: z.string().default('Letter'),
});
export const EvaluateActionSchema = z.object({
    code: z.string(),
});
export const ExtractPageContentActionSchema = z.object({
    value: z.string(),
});
export const ExtractStructuredDataActionSchema = z.object({
    query: z.string(),
    extract_links: z.boolean().default(false),
    start_from_char: z.number().int().default(0),
    output_schema: z.record(z.string(), z.unknown()).nullable().optional(),
    already_collected: z.array(z.string()).default([]),
});
export const SearchPageActionSchema = z.object({
    pattern: z.string(),
    regex: z.boolean().default(false),
    case_sensitive: z.boolean().default(false),
    context_chars: z.number().int().default(150),
    css_scope: z.string().optional(),
    max_results: z.number().int().default(25),
});
export const FindElementsActionSchema = z.object({
    selector: z.string(),
    attributes: z.array(z.string()).optional(),
    max_results: z.number().int().default(50),
    include_text: z.boolean().default(true),
});
export const ReadFileActionSchema = z.object({
    file_name: z.string(),
});
export const WriteFileActionSchema = z.object({
    file_name: z.string(),
    content: z.string(),
    append: z.boolean().optional(),
    trailing_newline: z.boolean().optional(),
    leading_newline: z.boolean().optional(),
});
export const ReplaceFileStrActionSchema = z.object({
    file_name: z.string(),
    old_str: z.string(),
    new_str: z.string(),
});
export const ScrollToTextActionSchema = z.object({
    text: z.string(),
});
export const DropdownOptionsActionSchema = z.object({
    index: lenientInt(0),
});
export const SelectDropdownActionSchema = z.object({
    index: lenientInt(0),
    text: z.string(),
});
export const SheetsRangeActionSchema = z.object({
    cell_or_range: z.string(),
});
export const SheetsUpdateActionSchema = z.object({
    cell_or_range: z.string(),
    value: z.string(),
});
export const SheetsInputActionSchema = z.object({
    text: z.string(),
});
export const NoParamsActionSchema = z
    .object({
    description: z.string().optional(),
})
    .passthrough();
