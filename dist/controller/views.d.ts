import { z } from 'zod';
export declare const lenientInt: (min?: number) => z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodNumber>;
export declare const lenientNumber: () => z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodNumber>;
export declare const lenientBool: (defaultValue?: boolean) => z.ZodPipe<z.ZodTransform<{}, unknown>, z.ZodBoolean>;
export declare const SearchGoogleActionSchema: z.ZodObject<{
    query: z.ZodString;
}, z.core.$strip>;
export type SearchGoogleAction = z.infer<typeof SearchGoogleActionSchema>;
export declare const SearchActionSchema: z.ZodObject<{
    query: z.ZodString;
    engine: z.ZodDefault<z.ZodString>;
}, z.core.$strip>;
export type SearchAction = z.infer<typeof SearchActionSchema>;
export declare const GoToUrlActionSchema: z.ZodObject<{
    url: z.ZodString;
    new_tab: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export type GoToUrlAction = z.infer<typeof GoToUrlActionSchema>;
export declare const WaitActionSchema: z.ZodObject<{
    seconds: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
export type WaitAction = z.infer<typeof WaitActionSchema>;
export declare const ClickElementActionSchema: z.ZodObject<{
    index: z.ZodOptional<z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodNumber>>;
    coordinate_x: z.ZodOptional<z.ZodNumber>;
    coordinate_y: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export type ClickElementAction = z.infer<typeof ClickElementActionSchema>;
export declare const ClickElementActionIndexOnlySchema: z.ZodObject<{
    index: z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodNumber>;
}, z.core.$strip>;
export type ClickElementActionIndexOnly = z.infer<typeof ClickElementActionIndexOnlySchema>;
export declare const InputTextActionSchema: z.ZodObject<{
    index: z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodNumber>;
    text: z.ZodString;
    clear: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export type InputTextAction = z.infer<typeof InputTextActionSchema>;
export declare const DoneActionSchema: z.ZodObject<{
    text: z.ZodString;
    success: z.ZodDefault<z.ZodBoolean>;
    files_to_display: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export type DoneAction = z.infer<typeof DoneActionSchema>;
export declare const StructuredOutputActionSchema: <T extends z.ZodTypeAny>(dataSchema: T) => z.ZodObject<{
    success: z.ZodDefault<z.ZodBoolean>;
    data: T;
}, z.core.$strip>;
export type StructuredOutputAction<T> = {
    success: boolean;
    data: T;
};
export declare const SwitchTabActionSchema: z.ZodObject<{
    page_id: z.ZodOptional<z.ZodNumber>;
    tab_id: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type SwitchTabAction = z.infer<typeof SwitchTabActionSchema>;
export declare const CloseTabActionSchema: z.ZodObject<{
    page_id: z.ZodOptional<z.ZodNumber>;
    tab_id: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type CloseTabAction = z.infer<typeof CloseTabActionSchema>;
export declare const ScrollActionSchema: z.ZodObject<{
    down: z.ZodDefault<z.ZodBoolean>;
    num_pages: z.ZodDefault<z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodNumber>>;
    pages: z.ZodOptional<z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodNumber>>;
    index: z.ZodOptional<z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodNumber>>;
}, z.core.$strip>;
export type ScrollAction = z.infer<typeof ScrollActionSchema>;
export declare const SendKeysActionSchema: z.ZodObject<{
    keys: z.ZodString;
}, z.core.$strip>;
export type SendKeysAction = z.infer<typeof SendKeysActionSchema>;
export declare const UploadFileActionSchema: z.ZodObject<{
    index: z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodNumber>;
    path: z.ZodString;
}, z.core.$strip>;
export type UploadFileAction = z.infer<typeof UploadFileActionSchema>;
export declare const ScreenshotActionSchema: z.ZodObject<{
    file_name: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type ScreenshotAction = z.infer<typeof ScreenshotActionSchema>;
export declare const SaveAsPdfActionSchema: z.ZodObject<{
    file_name: z.ZodOptional<z.ZodString>;
    print_background: z.ZodDefault<z.ZodBoolean>;
    landscape: z.ZodDefault<z.ZodBoolean>;
    scale: z.ZodDefault<z.ZodNumber>;
    paper_format: z.ZodDefault<z.ZodString>;
}, z.core.$strip>;
export type SaveAsPdfAction = z.infer<typeof SaveAsPdfActionSchema>;
export declare const EvaluateActionSchema: z.ZodObject<{
    code: z.ZodString;
}, z.core.$strip>;
export type EvaluateAction = z.infer<typeof EvaluateActionSchema>;
export declare const ExtractPageContentActionSchema: z.ZodObject<{
    value: z.ZodString;
}, z.core.$strip>;
export type ExtractPageContentAction = z.infer<typeof ExtractPageContentActionSchema>;
export declare const ExtractStructuredDataActionSchema: z.ZodObject<{
    query: z.ZodString;
    extract_links: z.ZodDefault<z.ZodBoolean>;
    start_from_char: z.ZodDefault<z.ZodNumber>;
    output_schema: z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
    already_collected: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export type ExtractStructuredDataAction = z.infer<typeof ExtractStructuredDataActionSchema>;
export declare const SearchPageActionSchema: z.ZodObject<{
    pattern: z.ZodString;
    regex: z.ZodDefault<z.ZodBoolean>;
    case_sensitive: z.ZodDefault<z.ZodBoolean>;
    context_chars: z.ZodDefault<z.ZodNumber>;
    css_scope: z.ZodOptional<z.ZodString>;
    max_results: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
export type SearchPageAction = z.infer<typeof SearchPageActionSchema>;
export declare const FindElementsActionSchema: z.ZodObject<{
    selector: z.ZodString;
    attributes: z.ZodOptional<z.ZodArray<z.ZodString>>;
    max_results: z.ZodDefault<z.ZodNumber>;
    include_text: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export type FindElementsAction = z.infer<typeof FindElementsActionSchema>;
export declare const ReadFileActionSchema: z.ZodObject<{
    file_name: z.ZodString;
}, z.core.$strip>;
export type ReadFileAction = z.infer<typeof ReadFileActionSchema>;
export declare const WriteFileActionSchema: z.ZodObject<{
    file_name: z.ZodString;
    content: z.ZodString;
    append: z.ZodOptional<z.ZodBoolean>;
    trailing_newline: z.ZodOptional<z.ZodBoolean>;
    leading_newline: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export type WriteFileAction = z.infer<typeof WriteFileActionSchema>;
export declare const ReplaceFileStrActionSchema: z.ZodObject<{
    file_name: z.ZodString;
    old_str: z.ZodString;
    new_str: z.ZodString;
}, z.core.$strip>;
export type ReplaceFileStrAction = z.infer<typeof ReplaceFileStrActionSchema>;
export declare const ScrollToTextActionSchema: z.ZodObject<{
    text: z.ZodString;
}, z.core.$strip>;
export type ScrollToTextAction = z.infer<typeof ScrollToTextActionSchema>;
export declare const DropdownOptionsActionSchema: z.ZodObject<{
    index: z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodNumber>;
}, z.core.$strip>;
export type DropdownOptionsAction = z.infer<typeof DropdownOptionsActionSchema>;
export declare const SelectDropdownActionSchema: z.ZodObject<{
    index: z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodNumber>;
    text: z.ZodString;
}, z.core.$strip>;
export type SelectDropdownAction = z.infer<typeof SelectDropdownActionSchema>;
export declare const SheetsRangeActionSchema: z.ZodObject<{
    cell_or_range: z.ZodString;
}, z.core.$strip>;
export type SheetsRangeAction = z.infer<typeof SheetsRangeActionSchema>;
export declare const SheetsUpdateActionSchema: z.ZodObject<{
    cell_or_range: z.ZodString;
    value: z.ZodString;
}, z.core.$strip>;
export type SheetsUpdateAction = z.infer<typeof SheetsUpdateActionSchema>;
export declare const SheetsInputActionSchema: z.ZodObject<{
    text: z.ZodString;
}, z.core.$strip>;
export type SheetsInputAction = z.infer<typeof SheetsInputActionSchema>;
export declare const NoParamsActionSchema: z.ZodObject<{
    description: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export type NoParamsAction = z.infer<typeof NoParamsActionSchema>;
