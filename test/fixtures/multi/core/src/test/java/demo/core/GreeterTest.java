package demo.core;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class GreeterTest {
    @Test
    public void greetsByName() {
        assertEquals("Hello, Lithe!", new Greeter().greet("Lithe"));
    }

    @Test
    public void keepsPunctuation() {
        assertEquals("Hello, a.b!", new Greeter().greet("a.b"));
    }
}
