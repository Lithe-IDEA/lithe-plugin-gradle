package demo.app;

import demo.core.Greeter;

public final class Main {
    public static void main(String[] args) {
        System.out.println(new Greeter().greet("Gradle"));
    }
}
