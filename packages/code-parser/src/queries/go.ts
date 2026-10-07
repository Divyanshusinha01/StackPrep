export const GO_QUERY = `
(function_declaration name: (identifier) @name) @definition.function
(method_declaration name: (field_identifier) @name) @definition.method
(type_declaration (type_spec name: (type_identifier) @name type: (struct_type)) @definition.class)
(type_declaration (type_spec name: (type_identifier) @name type: (interface_type)) @definition.interface)
(type_declaration (type_spec name: (type_identifier) @name) @definition.type)
(type_declaration (type_alias name: (type_identifier) @name) @definition.type)
(source_file (const_declaration (const_spec name: (identifier) @name) @definition.constant))
(source_file (var_declaration (var_spec name: (identifier) @name) @definition.variable))
(source_file (var_declaration (var_spec_list (var_spec name: (identifier) @name) @definition.variable)))

(import_spec path: (_) @import.source) @import

(call_expression function: (_) @call.callee) @call
`;
