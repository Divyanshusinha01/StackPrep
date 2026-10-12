import { C_FAMILY_BASE_QUERY } from "./c.ts";

export const CPP_QUERY = `${C_FAMILY_BASE_QUERY}
(class_specifier name: (type_identifier) @name body: (field_declaration_list)) @definition.class
(namespace_definition name: (_) @name) @definition.module
(alias_declaration name: (type_identifier) @name) @definition.type

(call_expression function: (qualified_identifier) @call.callee) @call
(call_expression function: (template_function name: (identifier) @call.callee)) @call
(new_expression type: (type_identifier) @call.callee) @call
`;
