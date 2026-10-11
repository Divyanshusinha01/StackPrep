package com.tidepool.reports;

import java.io.IOException;
import java.io.Writer;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;

/** Exports orders as CSV for the finance team. */
public class ReportExporter {
    private final Connection connection;

    public ReportExporter(Connection connection) {
        this.connection = connection;
    }

    /** Loads every order and writes one CSV row per order. */
    public void exportAll(Writer out) throws SQLException, IOException {
        List<String[]> rows = new ArrayList<>();
        try (Statement statement = connection.createStatement();
             ResultSet result = statement.executeQuery("select id, customer_id, currency, status from orders")) {
            while (result.next()) {
                rows.add(new String[] {result.getString(1), result.getString(2), result.getString(3), result.getString(4)});
            }
        }
        out.write("id,customer_id,currency,status\n");
        for (String[] row : rows) {
            out.write(String.join(",", row) + "\n");
        }
    }
}
